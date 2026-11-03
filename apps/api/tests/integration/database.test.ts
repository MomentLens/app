// The API's stores run against a real Postgres, through the API's own login (D-164). They check the
// parts a fake cannot: each SQL call's parameters, the types postgres.js returns, and the functions'
// rows as the zod schemas read them.
//
// It reads two URLs. TEST_DATABASE_URL is the momentlens_api login, which every store uses.
// TEST_ADMIN_DATABASE_URL is a role that can insert into auth.users, which is how these tests
// create accounts, since Auth is not in the loop. Without both, the file is skipped. Plain
// `pnpm test` skips it. Accounts use @store.test, and afterAll deletes them.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { pino } from 'pino';
import postgres from 'postgres';

import { PRIVACY_POLICY_VERSION } from '@momentlens/shared-types';
import type { CreateEventRequest } from '@momentlens/shared-types';

import { createDatabase, DATABASE_TIMEOUT_MS } from '../../src/db/sql';
import type { Sql } from '../../src/db/sql';
import { uploadKeys } from '../../src/lib/keys';
import { createAlbumStore } from '../../src/services/album';
import type { AttendeePage } from '../../src/services/attendees';
import { createAttendeeStore } from '../../src/services/attendees';
import { createConsentStore, createFindProfile } from '../../src/services/profiles';
import { createEventStore, MAX_ACTIVE_GUESTS } from '../../src/services/events';
import { createDatabaseCheck } from '../../src/services/health';
import { createInviteManagementStore, createInviteStore } from '../../src/services/invites';
import { createMediaStore, UPLOAD_LIMITS } from '../../src/services/media';
import { createMediaImagesStore } from '../../src/services/media-images';
import { createSubEventStore } from '../../src/services/sub-events';
import { createVenueQrStore } from '../../src/services/venue-qrs';

const APP_URL = process.env.TEST_DATABASE_URL;
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const describeDb = APP_URL && ADMIN_URL ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const T0 = Date.now() + 2 * 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const logger = pino({ level: 'silent' });

function request(overrides: Partial<CreateEventRequest> = {}): CreateEventRequest {
  return {
    requestId: randomUUID(),
    name: 'Store Test Wedding',
    type: 'wedding',
    description: '',
    approvalMode: 'auto',
    venues: [{ name: 'Hall', lat: 31.55, lng: 74.35 }],
    subEvents: [
      {
        name: 'Mehndi',
        startsAt: iso(T0),
        endsAt: iso(T0 + 4 * HOUR),
        venueIndex: 0,
        verificationRadiusM: 150,
      },
    ],
    ...overrides,
  };
}

async function makeUser(admin: postgres.Sql, fullName: string): Promise<string> {
  const id = randomUUID();
  await admin`
    insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (
      ${id}, 'authenticated', 'authenticated', ${`${id}@store.test`},
      ${admin.json({ full_name: fullName })}, now(), now()
    )`;
  return id;
}

describeDb('the API stores against Postgres', () => {
  let sql: Sql;
  let admin: postgres.Sql;
  let adminId: string;
  let guestId: string;
  let eventId: string;
  let mediaId: string;

  beforeAll(async () => {
    sql = createDatabase(APP_URL!);
    admin = postgres(ADMIN_URL!, { max: 1 });
    adminId = await makeUser(admin, 'Admin Person');
    guestId = await makeUser(admin, 'Guest Person');
    const created = await createEventStore(sql).create(adminId, request());
    if (created.outcome !== 'created') {
      throw new Error(`setup expected created, got ${created.outcome}`);
    }
    eventId = created.event.id;
  });

  afterAll(async () => {
    await sql.end();
    try {
      // media.uploader_user_id has no cascade, so a photo outlives its account until deleted here.
      await admin`
        delete from public.media
        where uploader_user_id in (select id from auth.users where email like '%@store.test')`;
      await admin`delete from auth.users where email like '%@store.test'`;
    } finally {
      await admin.end();
    }
  });

  it('answers the health check from the seeded row', async () => {
    expect(await createDatabaseCheck(sql, logger)()).toBe('ok');
  });

  it('runs as service_role, and cancels a statement past the deadline', async () => {
    expect(await sql`select session_user, current_user`).toEqual([
      { session_user: 'momentlens_api', current_user: 'service_role' },
    ]);
    const slept = sql`select pg_sleep(${DATABASE_TIMEOUT_MS / 1000 + 1})`;
    await expect(slept).rejects.toMatchObject({ code: '57014' });
  });

  it('reads the profile the signup trigger made', async () => {
    const profile = await createFindProfile(sql)(adminId);
    expect(profile?.fullName).toBe('Admin Person');
    expect(profile?.dnpActive).toBe(false);
  });

  it('creates an event once per request id, and reads it back for its admin', async () => {
    const events = createEventStore(sql);
    const body = request();
    const first = await events.create(adminId, body);
    expect(first.outcome).toBe('created');
    expect(await events.create(adminId, body)).toEqual({
      outcome: 'repeated',
      event: expect.objectContaining({ id: first.outcome === 'created' ? first.event.id : '' }),
    });
    expect((await events.create(guestId, body)).outcome).toBe('taken');

    if (first.outcome !== 'created') throw new Error('unreachable');
    const listed = await events.listForMember(adminId);
    expect(listed.map((event) => event.id)).toContain(first.event.id);

    const caller = await events.findForCaller(first.event.id, adminId);
    expect(caller?.membership?.role).toBe('admin');
    expect(caller?.event?.startsAt).toBe(iso(T0));
    // An Admin counts as verified for every sub-event (D-122).
    expect(caller?.verification?.everySubEvent).toBe(true);
  });

  it('reads and changes the settings, and opens and closes the album', async () => {
    const events = createEventStore(sql);
    const settings = await events.settings(eventId);
    expect(settings?.approvalMode).toBe('auto');

    const updated = await events.updateSettings(
      eventId,
      { name: 'Renamed Wedding' },
      MAX_ACTIVE_GUESTS,
    );
    expect(updated.outcome).toBe('updated');
    expect((await events.settings(eventId))?.name).toBe('Renamed Wedding');

    expect(await events.setAlbum(eventId, true)).toBe(true);
    expect((await events.albumStatus(eventId))?.albumOpen).toBe(true);
    expect(await events.setAlbum(eventId, false)).toBe(false);
  });

  it('adds, changes and removes a sub-event', async () => {
    const subEvents = createSubEventStore(sql);
    const added = await subEvents.add(eventId, {
      requestId: randomUUID(),
      name: 'Walima',
      startsAt: iso(T0 + 24 * HOUR),
      endsAt: iso(T0 + 28 * HOUR),
      venue: { name: 'Garden', lat: 31.5, lng: 74.3 },
      verificationRadiusM: 150,
    });
    if (added.outcome !== 'added') throw new Error(`expected added, got ${added.outcome}`);
    const walima = added.subEvents.find((subEvent) => subEvent.name === 'Walima');
    if (walima === undefined) throw new Error('the new sub-event is not in the schedule');

    expect((await subEvents.update(eventId, walima.id, { name: 'Walima Dinner' })).outcome).toBe(
      'updated',
    );
    expect((await subEvents.remove(eventId, walima.id)).outcome).toBe('deleted');
    expect((await subEvents.schedule(eventId))?.map((s) => s.name)).toEqual(['Mehndi']);
  });

  it('records a consent once', async () => {
    const consent = createConsentStore(sql);
    expect(await consent.accepted(guestId, PRIVACY_POLICY_VERSION)).toBe(false);
    expect(await consent.accept(guestId, PRIVACY_POLICY_VERSION)).toBe('created');
    expect(await consent.accept(guestId, PRIVACY_POLICY_VERSION)).toBe('repeated');
    expect(await consent.accepted(guestId, PRIVACY_POLICY_VERSION)).toBe(true);
  });

  it('admits a guest through an invite, then lists them as an attendee', async () => {
    const invites = createInviteManagementStore(sql);
    const listed = await invites.list(eventId, adminId);
    if (listed.outcome !== 'listed') throw new Error(`expected listed, got ${listed.outcome}`);
    const guestInvite = listed.invites.find((invite) => invite.role === 'guest');
    if (guestInvite === undefined) throw new Error('the event has no guest invite');

    const preview = await createInviteStore(sql).resolve({ token: guestInvite.token }, guestId);
    expect(preview?.role).toBe('guest');
    expect(preview?.event.name).toBe('Renamed Wedding');

    const joined = await createInviteStore(sql).join(
      guestId,
      { token: guestInvite.token },
      MAX_ACTIVE_GUESTS,
    );
    expect(joined.outcome).toBe('created');

    const firstPage: AttendeePage = {
      search: '',
      role: null,
      subEventId: null,
      checkIn: null,
      after: null,
    };
    const attendees = await createAttendeeStore(sql).list(eventId, adminId, firstPage);
    if (attendees.outcome !== 'listed')
      throw new Error(`expected listed, got ${attendees.outcome}`);
    expect(attendees.rows.map((row) => row.userId)).toContain(guestId);
  });

  it('uploads a photo as a guest, completes it, and reports it as processing', async () => {
    await createEventStore(sql).setAlbum(eventId, true);
    mediaId = randomUUID();
    const keys = uploadKeys(mediaId);
    const subEventId = (await createSubEventStore(sql).schedule(eventId))?.[0]?.id;
    if (subEventId === undefined) throw new Error('the event has no sub-event');

    const media = createMediaStore(sql);
    const started = await media.start(
      {
        mediaId,
        eventId,
        subEventId,
        userId: guestId,
        role: 'guest',
        contentHash: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        capturedAt: iso(T0 + HOUR),
        uploadKey: keys.photo,
        uploadThumbKey: keys.thumbnail,
        verifiedSubEventIds: [subEventId],
      },
      UPLOAD_LIMITS,
    );
    expect(started.outcome).toBe('created');

    const completed = await media.complete(mediaId, guestId, 2048);
    expect(completed).toEqual({ outcome: 'completed', messageId: expect.any(Number) });

    const statuses = await media.statuses(eventId, guestId, [mediaId]);
    expect(statuses.statuses).toEqual([{ mediaId, status: 'processing' }]);
  });

  it('shows a published photo in the album, its uploaders and the serving read', async () => {
    const albums = createAlbumStore(sql);
    expect((await albums.query(eventId, { limit: 50 })).media).toEqual([]);

    // What the worker's thumbnail_dims job writes, processed_at in the same update (D-123).
    await admin`
      update public.media
      set width = 4000, height = 3000, public_key = upload_key,
        public_thumb_key = upload_thumb_key, variant_version = 1, processed_at = now()
      where id = ${mediaId}`;

    const album = await albums.query(eventId, { limit: 50 });
    expect(album.media).toEqual([
      expect.objectContaining({ id: mediaId, width: 4000, height: 3000, variantVersion: 1 }),
    ]);
    // Postgres's microseconds survive, so the keyset cursor resumes exactly after this photo.
    expect(album.media[0]?.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/);

    const uploaders = await albums.uploaders(eventId);
    expect(uploaders.map((uploader) => uploader.userId)).toEqual([guestId]);

    const served = await createMediaImagesStore(sql).findForServing(eventId, [mediaId]);
    expect(served).toEqual([
      expect.objectContaining({ id: mediaId, publicKey: uploadKeys(mediaId).photo }),
    ]);
    expect(served[0]?.processedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/);
  });

  it('keeps the venue codes to the admin', async () => {
    const admin = await createVenueQrStore(sql).list(eventId, adminId);
    if (admin.outcome !== 'listed') throw new Error(`expected listed, got ${admin.outcome}`);
    expect(admin.venueQrs).toHaveLength(1);

    expect((await createVenueQrStore(sql).list(eventId, guestId)).outcome).toBe('wrong_role');
  });
});
