// The negative tests for RLS on health_check, profile, subject, event, venue, sub_event and
// membership (D-73, docs/ARCHITECTURE.md §1), and the tests that need a real database or real
// Auth: the trigger that creates a profile, the cascades, getClaims on a token the project signed
// (D-109), and create_event and list_my_events through the API's event store (D-110). It needs a
// real project, so it reads SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY for the
// dev project from the environment. Each test makes its own accounts under @momentlens.me and
// deletes them after, and deletes the events it made. No email is sent, because the accounts are
// created confirmed through the admin API.
//
// `pnpm --filter api test:rls` loads them from the root .env when it exists and sets
// REQUIRE_SUPABASE, so a missing value fails there instead of skipping. Plain `pnpm test` skips
// this file. CI runs test:rls in .github/workflows/rls.yml with the dev project's keys as
// repository secrets (D-106).
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { createClient } from '@supabase/supabase-js';
import { pino } from 'pino';

import { MAX_EVENT_SPAN_MS } from '@momentlens/shared-types';
import type { CreateEventRequest } from '@momentlens/shared-types';

import { createServerClient } from '../../src/db/supabase';
import { createTokenVerifier } from '../../src/middleware/auth';
import { createEventParams, createEventStore } from '../../src/services/events';
import { createDatabaseCheck } from '../../src/services/health';
import { createFindProfile } from '../../src/services/profiles';

// A test here makes up to about 20 requests in sequence to the dev project in Frankfurt, two of
// them account creations, and from a GitHub runner that passed Jest's default 5 seconds.
jest.setTimeout(30_000);

function projectFromEnv() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  return url && secretKey && publishableKey ? { url, secretKey, publishableKey } : null;
}

const project = projectFromEnv();
const required = process.env.REQUIRE_SUPABASE === '1';

if (project === null) {
  if (required) {
    it('has the dev project settings it needs', () => {
      throw new Error(
        'Set SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY for the dev project in the root .env',
      );
    });
  } else {
    it.skip('needs the dev project; run pnpm --filter api test:rls', () => undefined);
  }
} else {
  const silent = pino({ level: 'silent' });
  const admin = createServerClient(project.url, project.secretKey);
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  function newEmail(): string {
    return `rls-test+${randomUUID()}@momentlens.me`;
  }

  // Creates a confirmed account with this signup metadata, as the app's signUp sends it.
  async function createUser(metadata: Record<string, unknown>, email = newEmail()) {
    const password = randomUUID();
    const result = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (result.data.user) {
      created.push(result.data.user.id);
    }
    return { ...result, email, password };
  }

  async function createNamedUser(fullName = 'Test User') {
    const result = await createUser({ full_name: fullName });
    expect(result.error).toBeNull();
    if (result.data.user === null) {
      throw new Error('createUser returned no user');
    }
    return { id: result.data.user.id, email: result.email, password: result.password };
  }

  // A client that queries as this user, with the publishable key and their access token, as the
  // app would if it skipped the API.
  const signedInClient = async (user: { email: string; password: string }) => {
    const session = await createServerClient(
      project.url,
      project.publishableKey,
    ).auth.signInWithPassword({ email: user.email, password: user.password });
    expect(session.error).toBeNull();
    const accessToken = session.data.session?.access_token ?? '';
    return createClient(project.url, project.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  };

  describe('health_check in the dev project', () => {
    it('shows the seeded row to the secret key', async () => {
      const secret = createServerClient(project.url, project.secretKey);
      const result = await secret.from('health_check').select('id');
      expect(result.error).toBeNull();
      expect(result.data).toEqual([{ id: 1 }]);
    });

    it('shows no rows, and no error, to the publishable key', async () => {
      const publishable = createServerClient(project.url, project.publishableKey);
      const result = await publishable.from('health_check').select('id');
      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    });

    it('reports ok through the real database check with the secret key', async () => {
      const check = createDatabaseCheck(createServerClient(project.url, project.secretKey), silent);
      await expect(check()).resolves.toBe('ok');
    });

    it('reports error, not ok, when the check is handed the publishable key', async () => {
      const check = createDatabaseCheck(
        createServerClient(project.url, project.publishableKey),
        silent,
      );
      await expect(check()).resolves.toBe('error');
    });
  });

  describe('profile and subject in the dev project', () => {
    async function readProfile(userId: string) {
      const result = await admin
        .from('profile')
        .select('user_id, full_name, avatar_key, notify_approval, notify_album')
        .eq('user_id', userId)
        .maybeSingle();
      expect(result.error).toBeNull();
      return result.data;
    }

    async function countSubjects(userId: string): Promise<number> {
      const result = await admin
        .from('subject')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      expect(result.error).toBeNull();
      return result.count ?? -1;
    }

    it('creates the profile from the signup name, trimmed, with both notifications on', async () => {
      // U+3000 and U+00A0 are whitespace to String.prototype.trim, which FullName uses.
      const user = await createNamedUser('\u3000 Ayesha Khan\u00a0\t');
      await expect(readProfile(user.id)).resolves.toEqual({
        user_id: user.id,
        full_name: 'Ayesha Khan',
        avatar_key: null,
        notify_approval: true,
        notify_album: true,
      });
    });

    it('counts code points, so a name of 80 emoji is accepted', async () => {
      const name = '\u{1F600}'.repeat(80);
      const user = await createNamedUser(name);
      expect((await readProfile(user.id))?.full_name).toBe(name);
    });

    it.each([
      ['no name', {}],
      ['a blank name', { full_name: ' \u3000\t\u00a0' }],
      ['an 81-character name', { full_name: 'a'.repeat(81) }],
      ['a name that is not a string', { full_name: 42 }],
    ])(
      'refuses signup with %s, so no account exists without a profile',
      async (_case, metadata) => {
        const email = newEmail();
        const refused = await createUser(metadata, email);
        expect(refused.error).not.toBeNull();
        expect(refused.data.user).toBeNull();

        // The same address signs up with a valid name, which it could not if the refused attempt
        // had left an account behind.
        const retried = await createUser({ full_name: 'Valid Name' }, email);
        expect(retried.error).toBeNull();
      },
    );

    it('keeps one subject per user, and any number with no user', async () => {
      const user = await createNamedUser();
      expect((await admin.from('subject').insert({ user_id: user.id })).error).toBeNull();
      const second = await admin.from('subject').insert({ user_id: user.id });
      expect(second.error?.code).toBe('23505');

      const proxies = await admin
        .from('subject')
        .insert([{ user_id: null }, { user_id: null }])
        .select('id');
      expect(proxies.error).toBeNull();
      const proxyIds = (proxies.data ?? []).map((row: { id: string }) => row.id);
      expect(proxyIds).toHaveLength(2);
      expect((await admin.from('subject').delete().in('id', proxyIds)).error).toBeNull();
    });

    it('deletes the profile and the subject with the account (ON DELETE CASCADE)', async () => {
      const user = await createNamedUser();
      expect((await admin.from('subject').insert({ user_id: user.id })).error).toBeNull();
      expect((await admin.auth.admin.deleteUser(user.id)).error).toBeNull();
      await expect(readProfile(user.id)).resolves.toBeNull();
      await expect(countSubjects(user.id)).resolves.toBe(0);
    });

    // Every write is checked by its effect, read back with the secret key, so the test does not
    // depend on whether the refusal arrives as an error or as zero rows.
    async function expectNoAccess(client: ReturnType<typeof createServerClient>, ownId: string) {
      const other = await createNamedUser('Other Person');
      await admin.from('subject').insert({ user_id: other.id });

      for (const table of ['profile', 'subject'] as const) {
        const read = await client.from(table).select('*');
        expect(read.error).toBeNull();
        expect(read.data).toEqual([]);
      }

      for (const target of [ownId, other.id]) {
        await client.from('profile').update({ full_name: 'Changed' }).eq('user_id', target);
        await client.from('profile').delete().eq('user_id', target);
        await client
          .from('subject')
          .update({ dnp_activated_at: new Date().toISOString() })
          .eq('user_id', target);
        await client.from('subject').delete().eq('user_id', target);
      }
      expect((await readProfile(other.id))?.full_name).toBe('Other Person');
      expect(await readProfile(ownId)).not.toBeNull();
      await expect(countSubjects(other.id)).resolves.toBe(1);
      const otherSubject = await admin
        .from('subject')
        .select('dnp_activated_at')
        .eq('user_id', other.id)
        .single();
      expect(otherSubject.data).toEqual({ dnp_activated_at: null });

      const stranger = randomUUID();
      await client.from('profile').insert({ user_id: stranger, full_name: 'Inserted' });
      await client.from('subject').insert({ user_id: ownId });
      await expect(readProfile(stranger)).resolves.toBeNull();
      await expect(countSubjects(ownId)).resolves.toBe(0);
    }

    it('shows the publishable key no rows and lets it write nothing', async () => {
      const own = await createNamedUser();
      await expectNoAccess(createServerClient(project.url, project.publishableKey), own.id);
    });

    it('shows a signed-in user no rows, their own included, and lets them write nothing', async () => {
      const own = await createNamedUser();
      await expectNoAccess(await signedInClient(own), own.id);
    });

    it("reads the caller's profile through the API's service", async () => {
      const user = await createNamedUser('Service Reader');
      const find = createFindProfile(admin);
      await expect(find(user.id)).resolves.toEqual({
        userId: user.id,
        fullName: 'Service Reader',
        avatarKey: null,
        dnpActive: false,
      });
      await expect(find(randomUUID())).resolves.toBeNull();
    });

    it('verifies a token the project signed, locally, with an asymmetric key (arch §7)', async () => {
      const user = await createNamedUser();
      const session = await createServerClient(
        project.url,
        project.publishableKey,
      ).auth.signInWithPassword({ email: user.email, password: user.password });
      const accessToken = session.data.session?.access_token ?? '';

      const header = JSON.parse(
        Buffer.from(accessToken.split('.')[0] ?? '', 'base64url').toString(),
      ) as { alg?: string; kid?: string };
      expect(header.alg).toMatch(/^(ES|RS)256$/);
      expect(header.kid).toEqual(expect.any(String));

      const verify = createTokenVerifier(createServerClient(project.url, project.secretKey));
      await expect(verify(accessToken)).resolves.toEqual({ id: user.id });
    });
  });

  // create_event, list_my_events and the four tables S-02 adds (D-110, arch:event, arch:venue,
  // arch:sub_event, arch:membership), through the store the API uses.
  describe('event, venue, sub_event and membership in the dev project', () => {
    const store = createEventStore(admin);
    const events: string[] = [];
    const HOUR = 60 * 60 * 1000;
    const T0 = Date.parse('2026-12-10T14:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();

    afterAll(async () => {
      // Deleting the event deletes its venues, sub-events and memberships with it.
      if (events.length > 0) {
        await admin.from('event').delete().in('id', events);
      }
    });

    function request(overrides: Partial<CreateEventRequest> = {}): CreateEventRequest {
      return {
        requestId: randomUUID(),
        name: 'RLS Test Wedding',
        type: 'wedding',
        description: '',
        verificationRadiusM: 150,
        venues: [
          { name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 },
          { name: 'Family Home', lat: 31.52, lng: 74.35 },
        ],
        subEvents: [
          {
            name: 'Mehndi',
            description: 'Yellow dress code',
            startsAt: iso(T0),
            endsAt: iso(T0 + 4 * HOUR),
            venueIndex: 1,
          },
          {
            name: 'Baraat',
            startsAt: iso(T0 + 24 * HOUR),
            endsAt: iso(T0 + 30 * HOUR),
            venueIndex: 0,
          },
          {
            name: 'Walima',
            startsAt: iso(T0 + 48 * HOUR),
            endsAt: iso(T0 + 52 * HOUR),
            venueIndex: 0,
          },
        ],
        ...overrides,
      };
    }

    async function create(userId: string, body: CreateEventRequest = request()) {
      const result = await store.create(userId, body);
      if (result.outcome === 'created') {
        events.push(result.event.id);
      }
      return result;
    }

    async function createdEvent(userId: string, body?: CreateEventRequest) {
      const result = await create(userId, body);
      if (result.outcome !== 'created') {
        throw new Error(`expected created, got ${result.outcome}`);
      }
      return result.event;
    }

    async function eventsWithRequestId(requestId: string) {
      const result = await admin.from('event').select('id').eq('create_request_id', requestId);
      expect(result.error).toBeNull();
      return result.data ?? [];
    }

    async function addMember(eventId: string, userId: string, role: string, status: string) {
      const result = await admin
        .from('membership')
        .insert({ event_id: eventId, user_id: userId, role, status });
      expect(result.error).toBeNull();
    }

    it('creates the event, its venues, its sub-events and the Admin row in one call', async () => {
      const a = await createNamedUser();
      const body = request();
      const event = await createdEvent(a.id, body);
      expect(event).toEqual({
        id: expect.any(String),
        name: 'RLS Test Wedding',
        type: 'wedding',
        role: 'admin',
        coverKey: null,
        startsAt: iso(T0),
        endsAt: iso(T0 + 52 * HOUR),
        archivedAt: null,
      });

      const row = await admin
        .from('event')
        .select(
          'name, type, description, cover_key, venue_id, verification_radius_m, approval_mode, album_open, create_request_id, deleted_at, archived_at',
        )
        .eq('id', event.id)
        .single();
      expect(row.error).toBeNull();
      expect(row.data).toMatchObject({
        name: 'RLS Test Wedding',
        type: 'wedding',
        // An empty description is stored as none.
        description: null,
        cover_key: null,
        verification_radius_m: 150,
        approval_mode: 'auto',
        album_open: false,
        create_request_id: body.requestId,
        deleted_at: null,
        archived_at: null,
      });

      const venues = await admin
        .from('venue')
        .select('id, name, lat, lng, qr_secret')
        .eq('event_id', event.id);
      expect(venues.error).toBeNull();
      const venueRows = (venues.data ?? []) as {
        id: string;
        name: string;
        lat: number;
        lng: number;
        qr_secret: string;
      }[];
      expect(venueRows).toHaveLength(2);
      const hotel = venueRows.find((v) => v.name === 'Pearl Continental');
      const home = venueRows.find((v) => v.name === 'Family Home');
      // venues[0] is the event's own venue.
      expect((row.data as { venue_id: string }).venue_id).toBe(hotel?.id);
      expect([hotel?.lat, hotel?.lng]).toEqual([31.5546, 74.3572]);
      for (const venue of venueRows) {
        // PostgREST returns bytea as \x and its hex: 32 bytes is 64 hex digits.
        expect(venue.qr_secret).toMatch(/^\\x[0-9a-f]{64}$/);
      }
      expect(new Set(venueRows.map((v) => v.qr_secret)).size).toBe(2);

      const subEvents = await admin
        .from('sub_event')
        .select('name, description, starts_at, ends_at, venue_id')
        .eq('event_id', event.id);
      expect(subEvents.error).toBeNull();
      const byEvent = new Map(
        (subEvents.data ?? []).map((s: { name: string }) => [s.name, s as Record<string, unknown>]),
      );
      expect(byEvent.get('Mehndi')).toMatchObject({
        description: 'Yellow dress code',
        venue_id: home?.id,
      });
      expect(new Date(byEvent.get('Mehndi')?.starts_at as string).toISOString()).toBe(iso(T0));
      // Two sub-events at one hall share its one venue row, and so its one QR.
      expect(byEvent.get('Baraat')).toMatchObject({ description: null, venue_id: hotel?.id });
      expect(byEvent.get('Walima')).toMatchObject({ venue_id: hotel?.id });

      const members = await admin
        .from('membership')
        .select('user_id, role, status, admin_verified_at, last_viewed_at')
        .eq('event_id', event.id);
      expect(members.data).toEqual([
        {
          user_id: a.id,
          role: 'admin',
          status: 'active',
          admin_verified_at: null,
          last_viewed_at: null,
        },
      ]);
    });

    it('returns the first event when the same caller repeats a requestId', async () => {
      const a = await createNamedUser();
      const body = request();
      const first = await createdEvent(a.id, body);
      const again = await create(a.id, { ...body, name: 'Renamed on retry' });
      expect(again).toEqual({ outcome: 'repeated', event: first });
      await expect(eventsWithRequestId(body.requestId)).resolves.toHaveLength(1);
    });

    it('makes one event when two creates with one requestId arrive at once', async () => {
      const a = await createNamedUser();
      const body = request();
      const results = await Promise.all([create(a.id, body), create(a.id, body)]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'repeated']);
      const ids = results.map((r) => ('event' in r ? r.event.id : null));
      expect(ids[0]).toBe(ids[1]);
      await expect(eventsWithRequestId(body.requestId)).resolves.toHaveLength(1);
    });

    it("never returns A's event to B reusing A's requestId", async () => {
      const [a, b] = [await createNamedUser(), await createNamedUser()];
      const body = request();
      const first = await createdEvent(a.id, body);
      await expect(create(b.id, { ...body, name: 'B event' })).resolves.toEqual({
        outcome: 'taken',
      });
      await expect(eventsWithRequestId(body.requestId)).resolves.toEqual([{ id: first.id }]);
      await expect(store.listForMember(b.id)).resolves.toEqual([]);
    });

    it('answers no_account for a user id with no account, and leaves nothing behind', async () => {
      const body = request();
      await expect(create(randomUUID(), body)).resolves.toEqual({ outcome: 'no_account' });
      await expect(eventsWithRequestId(body.requestId)).resolves.toEqual([]);
    });

    it('lists an event to active members only, and to nobody once soft-deleted', async () => {
      const [a, b] = [await createNamedUser(), await createNamedUser()];
      const body = request();
      const event = await createdEvent(a.id, body);
      await expect(store.listForMember(b.id)).resolves.toEqual([]);

      await addMember(event.id, b.id, 'guest', 'pending');
      for (const status of ['pending', 'blocked', 'removed']) {
        await admin
          .from('membership')
          .update({ status })
          .eq('event_id', event.id)
          .eq('user_id', b.id);
        await expect(store.listForMember(b.id)).resolves.toEqual([]);
      }

      await admin
        .from('membership')
        .update({ status: 'active' })
        .eq('event_id', event.id)
        .eq('user_id', b.id);
      await expect(store.listForMember(b.id)).resolves.toEqual([{ ...event, role: 'guest' }]);

      await admin.from('event').update({ deleted_at: new Date().toISOString() }).eq('id', event.id);
      await expect(store.listForMember(a.id)).resolves.toEqual([]);
      await expect(store.listForMember(b.id)).resolves.toEqual([]);
      // A retry of the create that made it finds it gone, rather than returning a deleted event.
      await expect(create(a.id, body)).resolves.toEqual({ outcome: 'gone' });
    });

    it('lists an archived event with the time it was archived', async () => {
      const a = await createNamedUser();
      const event = await createdEvent(a.id);
      const archivedAt = '2026-12-20T09:30:00.123Z';
      await admin.from('event').update({ archived_at: archivedAt }).eq('id', event.id);
      await expect(store.listForMember(a.id)).resolves.toEqual([{ ...event, archivedAt }]);
    });

    it.each([
      ['no sub-events', { subEvents: [] }],
      [
        '16 sub-events',
        {
          venues: [{ name: 'Hall', lat: 31.5, lng: 74.3 }],
          subEvents: Array.from({ length: 16 }, (_, i) => ({
            name: `Sub-event ${i + 1}`,
            startsAt: iso(T0 + i * HOUR),
            endsAt: iso(T0 + i * HOUR + HOUR / 2),
            venueIndex: 0,
          })),
        },
      ],
      [
        'a span one millisecond over 336 hours',
        {
          venues: [{ name: 'Hall', lat: 31.5, lng: 74.3 }],
          subEvents: [
            { name: 'First', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 },
            {
              name: 'Last',
              startsAt: iso(T0 + 2 * HOUR),
              endsAt: iso(T0 + MAX_EVENT_SPAN_MS + 1),
              venueIndex: 0,
            },
          ],
        },
      ],
      ['a radius of 49 m', { verificationRadiusM: 49 }],
      ['a radius of 2001 m', { verificationRadiusM: 2001 }],
      [
        'an extra venue no sub-event uses',
        {
          subEvents: [{ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }],
        },
      ],
      [
        'a venue index out of range',
        {
          subEvents: [{ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 2 }],
        },
      ],
      [
        'a sub-event ending when it starts',
        {
          venues: [{ name: 'Hall', lat: 31.5, lng: 74.3 }],
          subEvents: [{ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0), venueIndex: 0 }],
        },
      ],
      ['a name with spaces around it', { name: ' Padded ' }],
      ['an 81-character name', { name: 'a'.repeat(81) }],
      ['an unknown type', { type: 'party' as CreateEventRequest['type'] }],
    ])(
      'refuses %s in SQL too, and leaves no rows, if the contract check is ever skipped',
      async (_case, overrides) => {
        const a = await createNamedUser();
        const body = request(overrides);
        const result = await admin.rpc('create_event', createEventParams(a.id, body));
        expect(result.error).not.toBeNull();
        await expect(eventsWithRequestId(body.requestId)).resolves.toEqual([]);
        await expect(store.listForMember(a.id)).resolves.toEqual([]);
      },
    );

    it('keeps exactly one Admin per event, and keeps it active', async () => {
      const [a, b] = [await createNamedUser(), await createNamedUser()];
      const event = await createdEvent(a.id);
      const second = await admin
        .from('membership')
        .insert({ event_id: event.id, user_id: b.id, role: 'admin', status: 'active' });
      expect(second.error?.code).toBe('23505');

      const demoted = await admin
        .from('membership')
        .update({ status: 'removed' })
        .eq('event_id', event.id)
        .eq('user_id', a.id);
      expect(demoted.error?.code).toBe('23514');

      const twice = await admin
        .from('membership')
        .insert({ event_id: event.id, user_id: a.id, role: 'guest', status: 'active' });
      expect(twice.error?.code).toBe('23505');
    });

    it("refuses a sub-event at another event's venue", async () => {
      const a = await createNamedUser();
      const [mine, theirs] = [await createdEvent(a.id), await createdEvent(a.id)];
      const theirVenue = await admin.from('event').select('venue_id').eq('id', theirs.id).single();
      const result = await admin.from('sub_event').insert({
        event_id: mine.id,
        name: 'Borrowed hall',
        starts_at: iso(T0),
        ends_at: iso(T0 + HOUR),
        venue_id: (theirVenue.data as { venue_id: string }).venue_id,
      });
      expect(result.error?.code).toBe('23503');
    });

    it("sets a cover only inside the event's own cover keys, and never on a deleted event", async () => {
      const a = await createNamedUser();
      const [event, other] = [await createdEvent(a.id), await createdEvent(a.id)];

      const key = `events/${event.id}/cover_${randomUUID()}.jpg`;
      await expect(store.setCover(event.id, key)).resolves.toBe(true);
      const [listed] = (await store.listForMember(a.id)).filter((e) => e.id === event.id);
      expect(listed?.coverKey).toBe(key);

      const foreign = await admin
        .from('event')
        .update({ cover_key: `events/${other.id}/cover_${randomUUID()}.jpg` })
        .eq('id', event.id);
      expect(foreign.error?.code).toBe('23514');

      await expect(store.findAccess(event.id, a.id)).resolves.toEqual({
        deleted: false,
        membership: { role: 'admin', status: 'active' },
      });
      await admin.from('event').update({ deleted_at: new Date().toISOString() }).eq('id', event.id);
      await expect(
        store.setCover(event.id, `events/${event.id}/cover_${randomUUID()}.jpg`),
      ).resolves.toBe(false);
      await expect(store.findAccess(event.id, a.id)).resolves.toEqual({
        deleted: true,
        membership: { role: 'admin', status: 'active' },
      });
      await expect(store.findAccess(randomUUID(), a.id)).resolves.toBeNull();
    });

    it('shows the publishable key and a signed-in member no rows, and lets neither write or call a function', async () => {
      const a = await createNamedUser();
      const event = await createdEvent(a.id);
      const clients = [
        createServerClient(project.url, project.publishableKey),
        // The event's own Admin, who still reads nothing directly (root invariant 14).
        await signedInClient(a),
      ];

      for (const client of clients) {
        for (const table of ['event', 'venue', 'sub_event', 'membership'] as const) {
          const read = await client.from(table).select('*');
          expect(read.error).toBeNull();
          expect(read.data).toEqual([]);
        }

        await client.from('event').update({ name: 'Changed', album_open: true }).eq('id', event.id);
        await client.from('venue').update({ name: 'Changed' }).eq('event_id', event.id);
        await client.from('sub_event').update({ name: 'Changed' }).eq('event_id', event.id);
        await client.from('membership').update({ role: 'guest' }).eq('event_id', event.id);
        for (const table of ['sub_event', 'venue', 'membership', 'event'] as const) {
          const column = table === 'event' ? 'id' : 'event_id';
          await client.from(table).delete().eq(column, event.id);
        }
        await client.from('membership').insert({
          event_id: event.id,
          user_id: a.id,
          role: 'photographer',
          status: 'active',
        });

        const body = request();
        const createCall = await client.rpc('create_event', createEventParams(a.id, body));
        expect(createCall.error).not.toBeNull();
        await expect(eventsWithRequestId(body.requestId)).resolves.toEqual([]);
        const listCall = await client.rpc('list_my_events', { p_user_id: a.id });
        expect(listCall.error).not.toBeNull();
        expect(listCall.data).toBeNull();
      }

      await expect(store.listForMember(a.id)).resolves.toEqual([event]);
      const counts = await Promise.all(
        (['venue', 'sub_event', 'membership'] as const).map((table) =>
          admin.from(table).select('id', { count: 'exact', head: true }).eq('event_id', event.id),
        ),
      );
      expect(counts.map((c) => c.count)).toEqual([2, 3, 1]);
      const names = await admin.from('venue').select('name').eq('event_id', event.id);
      expect((names.data ?? []).map((v: { name: string }) => v.name).sort()).toEqual([
        'Family Home',
        'Pearl Continental',
      ]);
    });
  });
}
