// The negative tests for RLS on health_check, profile, subject, event, venue, sub_event,
// membership and invite (D-73, docs/ARCHITECTURE.md §1), and the tests that need a real database or
// real Auth: the trigger that creates a profile, the cascades, getClaims on a token the project
// signed (D-109), create_event and list_my_events through the API's event store (D-110),
// get_my_event through the same store (D-118), resolve_invite, join_event, the cancel and the join
// request list through the API's stores (D-115), and sub_event_schedule, add_sub_event,
// update_sub_event and delete_sub_event through the API's sub-event store (D-121). It needs a
// real project, so it reads SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY for the
// dev project from the environment. Each test makes its own accounts under @momentlens.me and
// deletes them after, and deletes the events it made. No email is sent, because the accounts are
// created confirmed through the admin API.
//
// `pnpm --filter api test:rls` loads them from the root .env when it exists and sets
// REQUIRE_SUPABASE, so a missing value fails there instead of skipping. Plain `pnpm test` skips
// this file. CI runs test:rls in .github/workflows/rls.yml with the dev project's keys as
// repository secrets (D-106).
import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { createClient } from '@supabase/supabase-js';
import { pino } from 'pino';

import {
  InviteToken,
  MAX_EVENT_SPAN_MS,
  SHORTCODE_ALPHABET,
  VERIFICATION_RADIUS_DEFAULT_M,
} from '@momentlens/shared-types';
import type {
  AddSubEventRequest,
  CreateEventRequest,
  SubEvent,
  SubEventInput,
  VenueChoice,
} from '@momentlens/shared-types';

import { createServerClient } from '../../src/db/supabase';
import { createTokenVerifier } from '../../src/middleware/auth';
import { createEventParams, createEventStore } from '../../src/services/events';
import { createDatabaseCheck } from '../../src/services/health';
import {
  createInviteStore,
  joinEventParams,
  MAX_ACTIVE_GUESTS,
  resolveInviteParams,
} from '../../src/services/invites';
import { createFindProfile } from '../../src/services/profiles';
import {
  addSubEventParams,
  createSubEventStore,
  updateSubEventParams,
} from '../../src/services/sub-events';

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

  // One delete per account the file made, in sequence. With S-04's tests that ran past the 30
  // seconds above from a laptop, which failed the suite after every test had passed.
  afterAll(async () => {
    for (const id of created) {
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

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

    // The trigger covers every account made since S-01's migration, and the backfill every live one
    // from before it (supabase/migrations/20260928202314_backfill_profiles.sql). GET /profiles/me
    // answers an account with no profile 401, so one that slips through looks like a broken
    // session. Other test runs may create or delete accounts meanwhile, so an account missing a
    // profile is read again before it counts.
    it('gives every live account a profile, the ones older than the trigger included', async () => {
      const live: string[] = [];
      for (let page = 1; ; page += 1) {
        const result = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        expect(result.error).toBeNull();
        const users = result.data.users;
        live.push(
          ...users.filter((user) => !user.is_anonymous && !user.deleted_at).map((user) => user.id),
        );
        if (users.length < 1000) break;
      }

      const withProfile = new Set<string>();
      for (let start = 0; start < live.length; start += 100) {
        const result = await admin
          .from('profile')
          .select('user_id')
          .in('user_id', live.slice(start, start + 100));
        expect(result.error).toBeNull();
        for (const id of (result.data ?? []).map((row: { user_id: string }) => row.user_id)) {
          withProfile.add(id);
        }
      }

      const missing: string[] = [];
      for (const id of live.filter((userId) => !withProfile.has(userId))) {
        const user = await admin.auth.admin.getUserById(id);
        if (user.data.user && !user.data.user.deleted_at && (await readProfile(id)) === null) {
          missing.push(id);
        }
      }
      expect(missing).toEqual([]);
    });

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

    // A sub-event at the slider's starting radius, unless the case sets its own (D-111).
    function subEvent(
      fields: Omit<SubEventInput, 'verificationRadiusM'> & { verificationRadiusM?: number },
    ): SubEventInput {
      return { verificationRadiusM: VERIFICATION_RADIUS_DEFAULT_M, ...fields };
    }

    function request(overrides: Partial<CreateEventRequest> = {}): CreateEventRequest {
      return {
        requestId: randomUUID(),
        name: 'RLS Test Wedding',
        type: 'wedding',
        description: '',
        approvalMode: 'auto',
        venues: [
          { name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 },
          { name: 'Family Home', lat: 31.52, lng: 74.35 },
        ],
        subEvents: [
          subEvent({
            name: 'Mehndi',
            description: 'Yellow dress code',
            startsAt: iso(T0),
            endsAt: iso(T0 + 4 * HOUR),
            venueIndex: 1,
            verificationRadiusM: 300,
          }),
          subEvent({
            name: 'Baraat',
            startsAt: iso(T0 + 24 * HOUR),
            endsAt: iso(T0 + 30 * HOUR),
            venueIndex: 0,
            verificationRadiusM: 150,
          }),
          subEvent({
            name: 'Walima',
            startsAt: iso(T0 + 48 * HOUR),
            endsAt: iso(T0 + 52 * HOUR),
            venueIndex: 0,
          }),
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
          'name, type, description, cover_key, approval_mode, album_open, create_request_id, deleted_at, archived_at',
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
      expect([hotel?.lat, hotel?.lng]).toEqual([31.5546, 74.3572]);
      for (const venue of venueRows) {
        // PostgREST returns bytea as \x and its hex: 32 bytes is 64 hex digits.
        expect(venue.qr_secret).toMatch(/^\\x[0-9a-f]{64}$/);
      }
      expect(new Set(venueRows.map((v) => v.qr_secret)).size).toBe(2);

      const subEvents = await admin
        .from('sub_event')
        .select('name, description, starts_at, ends_at, venue_id, verification_radius_m')
        .eq('event_id', event.id);
      expect(subEvents.error).toBeNull();
      const byEvent = new Map(
        (subEvents.data ?? []).map((s: { name: string }) => [s.name, s as Record<string, unknown>]),
      );
      expect(byEvent.get('Mehndi')).toMatchObject({
        description: 'Yellow dress code',
        venue_id: home?.id,
        verification_radius_m: 300,
      });
      expect(new Date(byEvent.get('Mehndi')?.starts_at as string).toISOString()).toBe(iso(T0));
      // Two sub-events at one hall share its one venue row, and so its one QR, and each keeps
      // its own radius (D-111).
      expect(byEvent.get('Baraat')).toMatchObject({
        description: null,
        venue_id: hotel?.id,
        verification_radius_m: 150,
      });
      expect(byEvent.get('Walima')).toMatchObject({
        venue_id: hotel?.id,
        verification_radius_m: VERIFICATION_RADIUS_DEFAULT_M,
      });

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

    it('stores the approval mode the wizard chose', async () => {
      const a = await createNamedUser();
      const event = await createdEvent(a.id, request({ approvalMode: 'manual' }));
      const row = await admin.from('event').select('approval_mode').eq('id', event.id).single();
      expect(row.error).toBeNull();
      expect(row.data).toEqual({ approval_mode: 'manual' });
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

    // get_my_event, read for GET /events/{eventId} (D-118).
    it('reads one event for an active member, and for nobody once soft-deleted', async () => {
      const [a, b] = [await createNamedUser(), await createNamedUser()];
      const event = await createdEvent(a.id);
      await expect(store.findForCaller(event.id, a.id)).resolves.toEqual({
        deleted: false,
        membership: { role: 'admin', status: 'active' },
        event,
      });
      await expect(store.findForCaller(event.id, b.id)).resolves.toEqual({
        deleted: false,
        membership: null,
        event: null,
      });

      await addMember(event.id, b.id, 'photographer', 'pending');
      for (const status of ['pending', 'blocked', 'removed'] as const) {
        await admin
          .from('membership')
          .update({ status })
          .eq('event_id', event.id)
          .eq('user_id', b.id);
        await expect(store.findForCaller(event.id, b.id)).resolves.toEqual({
          deleted: false,
          membership: { role: 'photographer', status },
          event: null,
        });
      }

      await admin
        .from('membership')
        .update({ status: 'active' })
        .eq('event_id', event.id)
        .eq('user_id', b.id);
      const forB = await store.findForCaller(event.id, b.id);
      expect(forB?.event).toEqual({ ...event, role: 'photographer' });
      // The same event, span included, that GET /events lists.
      await expect(store.listForMember(b.id)).resolves.toEqual([forB?.event]);

      await admin.from('event').update({ deleted_at: new Date().toISOString() }).eq('id', event.id);
      await expect(store.findForCaller(event.id, a.id)).resolves.toEqual({
        deleted: true,
        membership: { role: 'admin', status: 'active' },
        event: null,
      });
      await expect(store.findForCaller(event.id, b.id)).resolves.toEqual({
        deleted: true,
        membership: { role: 'photographer', status: 'active' },
        event: null,
      });
    });

    it('finds nothing for an event id that does not exist', async () => {
      const a = await createNamedUser();
      await expect(store.findForCaller(randomUUID(), a.id)).resolves.toBeNull();
    });

    it("never hands the API a refused caller's view of the event's name or cover", async () => {
      const [a, b] = [await createNamedUser(), await createNamedUser()];
      const event = await createdEvent(a.id);
      const coverKey = `events/${event.id}/cover_${randomUUID()}.jpg`;
      await admin.from('event').update({ cover_key: coverKey }).eq('id', event.id);
      const hidden = {
        id: null,
        name: null,
        type: null,
        cover_key: null,
        starts_at: null,
        ends_at: null,
        archived_at: null,
      };
      const row = async (userId: string) => {
        const result = await admin.rpc('get_my_event', {
          p_event_id: event.id,
          p_user_id: userId,
        });
        expect(result.error).toBeNull();
        expect(result.data).toHaveLength(1);
        return (result.data as unknown[])[0];
      };

      await expect(row(b.id)).resolves.toEqual({
        deleted: false,
        role: null,
        status: null,
        ...hidden,
      });
      await addMember(event.id, b.id, 'guest', 'pending');
      await expect(row(b.id)).resolves.toEqual({
        deleted: false,
        role: 'guest',
        status: 'pending',
        ...hidden,
      });
      await expect(row(a.id)).resolves.toMatchObject({
        name: 'RLS Test Wedding',
        cover_key: coverKey,
      });

      await admin.from('event').update({ deleted_at: new Date().toISOString() }).eq('id', event.id);
      await expect(row(a.id)).resolves.toEqual({
        deleted: true,
        role: 'admin',
        status: 'active',
        ...hidden,
      });
    });

    it('reads an archived event as usual, with the time it was archived', async () => {
      const a = await createNamedUser();
      const event = await createdEvent(a.id);
      const archivedAt = '2026-12-20T09:30:00.123Z';
      await admin.from('event').update({ archived_at: archivedAt }).eq('id', event.id);
      const found = await store.findForCaller(event.id, a.id);
      expect(found?.event).toEqual({ ...event, archivedAt });
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
          subEvents: Array.from({ length: 16 }, (_, i) =>
            subEvent({
              name: `Sub-event ${i + 1}`,
              startsAt: iso(T0 + i * HOUR),
              endsAt: iso(T0 + i * HOUR + HOUR / 2),
              venueIndex: 0,
            }),
          ),
        },
      ],
      [
        'a span one millisecond over 336 hours',
        {
          venues: [{ name: 'Hall', lat: 31.5, lng: 74.3 }],
          subEvents: [
            subEvent({ name: 'First', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }),
            subEvent({
              name: 'Last',
              startsAt: iso(T0 + 2 * HOUR),
              endsAt: iso(T0 + MAX_EVENT_SPAN_MS + 1),
              venueIndex: 0,
            }),
          ],
        },
      ],
      ...[49, 2001, 200.5, null].map((radius): [string, Partial<CreateEventRequest>] => [
        `a sub-event radius of ${radius} m`,
        {
          venues: [{ name: 'Hall', lat: 31.5, lng: 74.3 }],
          subEvents: [
            {
              name: 'Nikkah',
              startsAt: iso(T0),
              endsAt: iso(T0 + HOUR),
              venueIndex: 0,
              // Cast: the contract refuses each of these before the API ever calls the function.
              verificationRadiusM: radius as unknown as number,
            },
          ],
        },
      ]),
      [
        'a first venue no sub-event uses',
        {
          // Two sub-events for two venues, so the venue count passes and only this check fails.
          subEvents: [
            subEvent({ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 1 }),
            subEvent({
              name: 'Walima',
              startsAt: iso(T0 + 2 * HOUR),
              endsAt: iso(T0 + 3 * HOUR),
              venueIndex: 1,
            }),
          ],
        },
      ],
      [
        'more venues than sub-events',
        {
          venues: [
            { name: 'Hall', lat: 31.5, lng: 74.3 },
            { name: 'Lawn', lat: 31.6, lng: 74.3 },
            { name: 'Home', lat: 31.7, lng: 74.3 },
          ],
          subEvents: [
            subEvent({ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }),
            subEvent({
              name: 'Walima',
              startsAt: iso(T0 + 2 * HOUR),
              endsAt: iso(T0 + 3 * HOUR),
              venueIndex: 1,
            }),
          ],
        },
      ],
      [
        'an unknown approval mode',
        { approvalMode: 'invite_only' as CreateEventRequest['approvalMode'] },
      ],
      ['no approval mode', { approvalMode: null as unknown as CreateEventRequest['approvalMode'] }],
      [
        'an extra venue no sub-event uses',
        {
          subEvents: [
            subEvent({ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }),
          ],
        },
      ],
      [
        'a venue index out of range',
        {
          subEvents: [
            subEvent({ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 2 }),
          ],
        },
      ],
      [
        'a sub-event ending when it starts',
        {
          venues: [{ name: 'Hall', lat: 31.5, lng: 74.3 }],
          subEvents: [
            subEvent({ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0), venueIndex: 0 }),
          ],
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

    async function firstVenue(eventId: string): Promise<string> {
      const venue = await admin
        .from('venue')
        .select('id')
        .eq('event_id', eventId)
        .limit(1)
        .single();
      expect(venue.error).toBeNull();
      return (venue.data as { id: string }).id;
    }

    it("refuses a sub-event at another event's venue", async () => {
      const a = await createNamedUser();
      const [mine, theirs] = [await createdEvent(a.id), await createdEvent(a.id)];
      const result = await admin.from('sub_event').insert({
        event_id: mine.id,
        name: 'Borrowed hall',
        starts_at: iso(T0),
        ends_at: iso(T0 + HOUR),
        venue_id: await firstVenue(theirs.id),
      });
      expect(result.error?.code).toBe('23503');
    });

    it('gives a sub-event written with no radius 200 m, and refuses one outside 50 to 2000', async () => {
      const a = await createNamedUser();
      const event = await createdEvent(a.id);
      const venueId = await firstVenue(event.id);
      const row = {
        event_id: event.id,
        name: 'Added later',
        starts_at: iso(T0 + 60 * HOUR),
        ends_at: iso(T0 + 61 * HOUR),
        venue_id: venueId,
      };

      const plain = await admin
        .from('sub_event')
        .insert(row)
        .select('verification_radius_m')
        .single();
      expect(plain.error).toBeNull();
      expect(plain.data).toEqual({ verification_radius_m: VERIFICATION_RADIUS_DEFAULT_M });

      for (const radius of [49, 2001]) {
        const refused = await admin
          .from('sub_event')
          .insert({ ...row, verification_radius_m: radius });
        expect(refused.error?.code).toBe('23514');
      }
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
      const [a, b] = [await createNamedUser(), await createNamedUser()];
      const event = await createdEvent(a.id);
      const invite = await admin
        .from('invite')
        .select('token, shortcode')
        .eq('event_id', event.id)
        .eq('role', 'guest')
        .single();
      expect(invite.error).toBeNull();
      const { token, shortcode } = invite.data as { token: string; shortcode: string };
      const clients = [
        createServerClient(project.url, project.publishableKey),
        // The event's own Admin, who still reads nothing directly (root invariant 14).
        await signedInClient(a),
      ];

      for (const client of clients) {
        for (const table of ['event', 'venue', 'sub_event', 'membership', 'invite'] as const) {
          const read = await client.from(table).select('*');
          expect(read.error).toBeNull();
          expect(read.data).toEqual([]);
        }

        await client.from('event').update({ name: 'Changed', album_open: true }).eq('id', event.id);
        await client.from('venue').update({ name: 'Changed' }).eq('event_id', event.id);
        await client.from('sub_event').update({ name: 'Changed' }).eq('event_id', event.id);
        await client.from('membership').update({ role: 'guest' }).eq('event_id', event.id);
        await client
          .from('invite')
          .update({ revoked_at: new Date().toISOString() })
          .eq('event_id', event.id);
        await client.from('invite').insert({
          event_id: event.id,
          role: 'photographer',
          token: randomBytes(32).toString('base64url'),
          shortcode: 'AB3K7X',
          revoked_at: new Date().toISOString(),
        });
        for (const table of ['invite', 'sub_event', 'venue', 'membership', 'event'] as const) {
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
        const getCall = await client.rpc('get_my_event', {
          p_event_id: event.id,
          p_user_id: a.id,
        });
        expect(getCall.error).not.toBeNull();
        expect(getCall.data).toBeNull();
        // join_event takes the user as a parameter, so a caller who could run it could put anyone
        // into any event, past the cap. resolve_invite would read anyone's membership.
        const joinCall = await client.rpc(
          'join_event',
          joinEventParams(b.id, { token }, MAX_ACTIVE_GUESTS),
        );
        expect(joinCall.error).not.toBeNull();
        const resolveCall = await client.rpc(
          'resolve_invite',
          resolveInviteParams({ token }, a.id),
        );
        expect(resolveCall.error).not.toBeNull();
        expect(resolveCall.data).toBeNull();
        const issueCall = await client.rpc('issue_invite', {
          p_event_id: event.id,
          p_role: 'guest',
        });
        expect(issueCall.error).not.toBeNull();
        const tokenCall = await client.rpc('new_invite_token');
        expect(tokenCall.error).not.toBeNull();
        const shortcodeCall = await client.rpc('new_invite_shortcode');
        expect(shortcodeCall.error).not.toBeNull();
      }

      await expect(store.listForMember(a.id)).resolves.toEqual([event]);
      const counts = await Promise.all(
        (['venue', 'sub_event', 'membership'] as const).map((table) =>
          admin.from(table).select('id', { count: 'exact', head: true }).eq('event_id', event.id),
        ),
      );
      expect(counts.map((c) => c.count)).toEqual([2, 3, 1]);
      const live = await admin
        .from('invite')
        .select('role, token, shortcode')
        .eq('event_id', event.id)
        .is('revoked_at', null);
      expect(live.data).toHaveLength(2);
      expect(live.data).toContainEqual({ role: 'guest', token, shortcode });
      const all = await admin
        .from('invite')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', event.id);
      expect(all.count).toBe(2);
      const names = await admin.from('venue').select('name').eq('event_id', event.id);
      expect((names.data ?? []).map((v: { name: string }) => v.name).sort()).toEqual([
        'Family Home',
        'Pearl Continental',
      ]);
    });

    describe('invite, join_event and join requests', () => {
      const invites = createInviteStore(admin);

      interface InviteRow {
        id: string;
        role: string;
        token: string;
        shortcode: string;
      }

      interface MembershipRow {
        role: string;
        status: string;
        admin_verified_at: string | null;
        requested_at: string;
      }

      function newToken(): string {
        return randomBytes(32).toString('base64url');
      }

      function newCode(): string {
        return Array.from(randomBytes(6), (byte) => SHORTCODE_ALPHABET[byte % 31]).join('');
      }

      // The event's one live Guest invite and one live Photographer invite.
      async function liveInvites(eventId: string) {
        const result = await admin
          .from('invite')
          .select('id, role, token, shortcode')
          .eq('event_id', eventId)
          .is('revoked_at', null);
        expect(result.error).toBeNull();
        const rows = (result.data ?? []) as InviteRow[];
        const guest = rows.find((r) => r.role === 'guest');
        const photographer = rows.find((r) => r.role === 'photographer');
        if (rows.length !== 2 || guest === undefined || photographer === undefined) {
          throw new Error(`expected one live invite per role, got ${JSON.stringify(rows)}`);
        }
        return { guest, photographer };
      }

      async function membershipRow(eventId: string, userId: string): Promise<MembershipRow | null> {
        const result = await admin
          .from('membership')
          .select('role, status, admin_verified_at, requested_at')
          .eq('event_id', eventId)
          .eq('user_id', userId)
          .maybeSingle();
        expect(result.error).toBeNull();
        return result.data;
      }

      async function setEvent(eventId: string, fields: Record<string, unknown>) {
        const result = await admin.from('event').update(fields).eq('id', eventId);
        expect(result.error).toBeNull();
      }

      async function activeGuests(eventId: string) {
        const result = await admin
          .from('membership')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId)
          .eq('role', 'guest')
          .eq('status', 'active');
        expect(result.error).toBeNull();
        return result.count;
      }

      it('gives each new event one live Guest and one Photographer invite, and a repeat adds none', async () => {
        const a = await createNamedUser();
        const body = request();
        const event = await createdEvent(a.id, body);
        const { guest, photographer } = await liveInvites(event.id);
        for (const invite of [guest, photographer]) {
          expect(InviteToken.safeParse(invite.token).success).toBe(true);
          expect(invite.shortcode).toMatch(new RegExp(`^[${SHORTCODE_ALPHABET}]{6}$`));
        }
        expect(guest.token).not.toBe(photographer.token);
        expect(guest.shortcode).not.toBe(photographer.shortcode);

        await expect(create(a.id, body)).resolves.toMatchObject({ outcome: 'repeated' });
        const all = await admin
          .from('invite')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', event.id);
        expect(all.count).toBe(2);
      });

      it('keeps one live invite per role, and every token and code unique, revoked ones included', async () => {
        const a = await createNamedUser();
        const [event, other] = [await createdEvent(a.id), await createdEvent(a.id)];
        const { guest } = await liveInvites(event.id);

        const second = await admin
          .from('invite')
          .insert({ event_id: event.id, role: 'guest', token: newToken(), shortcode: newCode() });
        expect(second.error?.code).toBe('23505');

        // Revoke and regenerate, as S-05's share screen will (arch:invite).
        const revokedAt = new Date().toISOString();
        await admin.from('invite').update({ revoked_at: revokedAt }).eq('id', guest.id);
        const regenerated = await admin
          .from('invite')
          .insert({ event_id: event.id, role: 'guest', token: newToken(), shortcode: newCode() });
        expect(regenerated.error).toBeNull();

        // A revoked code or token is never issued again, to this event or another.
        for (const taken of [
          { token: guest.token, shortcode: newCode() },
          { token: newToken(), shortcode: guest.shortcode },
        ]) {
          const reused = await admin
            .from('invite')
            .insert({ event_id: other.id, role: 'guest', revoked_at: revokedAt, ...taken });
          expect(reused.error?.code).toBe('23505');
        }

        for (const bad of [
          { role: 'admin', token: newToken(), shortcode: newCode() },
          { role: 'guest', token: newToken().slice(1), shortcode: newCode() },
          { role: 'guest', token: `${newToken().slice(1)}+`, shortcode: newCode() },
          { role: 'guest', token: newToken(), shortcode: newCode().toLowerCase() },
          { role: 'guest', token: newToken(), shortcode: 'AB3K7O' },
          { role: 'guest', token: newToken(), shortcode: 'AB3K7' },
        ]) {
          const refused = await admin
            .from('invite')
            .insert({ event_id: other.id, revoked_at: revokedAt, ...bad });
          expect(refused.error?.code).toBe('23514');
        }
      });

      it('has a Guest and a Photographer invite for every event, the ones older than S-03 included', async () => {
        const [eventRows, inviteRows] = await Promise.all([
          admin.from('event').select('id'),
          admin.from('invite').select('event_id, role'),
        ]);
        expect(eventRows.error).toBeNull();
        expect(inviteRows.error).toBeNull();
        const issued = new Set(
          ((inviteRows.data ?? []) as { event_id: string; role: string }[]).map(
            (i) => `${i.event_id}:${i.role}`,
          ),
        );
        const missing = ((eventRows.data ?? []) as { id: string }[]).filter(
          (e) => !issued.has(`${e.id}:guest`) || !issued.has(`${e.id}:photographer`),
        );
        expect(missing).toEqual([]);
      });

      it('previews a live invite by token and by code, venue names in the order their first sub-event starts', async () => {
        const [a, b] = [await createNamedUser(), await createNamedUser()];
        const event = await createdEvent(a.id);
        const { guest, photographer } = await liveInvites(event.id);
        // Mehndi at Family Home starts first. Pearl Continental holds two sub-events and is named once.
        const preview = {
          role: 'guest',
          event: {
            id: event.id,
            name: 'RLS Test Wedding',
            coverKey: null,
            startsAt: iso(T0),
            endsAt: iso(T0 + 52 * HOUR),
            venueNames: ['Family Home', 'Pearl Continental'],
          },
          membership: null,
        };
        await expect(invites.resolve({ token: guest.token }, null)).resolves.toEqual(preview);
        await expect(invites.resolve({ code: guest.shortcode }, b.id)).resolves.toEqual(preview);
        await expect(invites.resolve({ token: photographer.token }, a.id)).resolves.toEqual({
          ...preview,
          role: 'photographer',
          membership: { role: 'admin', status: 'active' },
        });

        const key = `events/${event.id}/cover_${randomUUID()}.jpg`;
        await setEvent(event.id, { cover_key: key });
        await expect(invites.resolve({ token: guest.token }, null)).resolves.toMatchObject({
          event: { coverKey: key },
        });
      });

      it('treats an unknown, revoked, deleted-event or archived-event invite as dead, for a lookup and a join alike', async () => {
        const [a, b] = [await createNamedUser(), await createNamedUser()];
        const unknown = { token: newToken() };
        await expect(invites.resolve(unknown, b.id)).resolves.toBeNull();
        await expect(invites.join(b.id, unknown, MAX_ACTIVE_GUESTS)).resolves.toEqual({
          outcome: 'dead',
        });

        const revoked = await createdEvent(a.id);
        const revokedInvites = await liveInvites(revoked.id);
        await admin
          .from('invite')
          .update({ revoked_at: new Date().toISOString() })
          .eq('id', revokedInvites.guest.id);

        const deleted = await createdEvent(a.id);
        await setEvent(deleted.id, { deleted_at: new Date().toISOString() });
        const archived = await createdEvent(a.id);
        await setEvent(archived.id, { archived_at: new Date().toISOString() });

        const dead = [
          { eventId: revoked.id, invite: revokedInvites.guest },
          { eventId: deleted.id, invite: (await liveInvites(deleted.id)).guest },
          { eventId: archived.id, invite: (await liveInvites(archived.id)).photographer },
        ];
        for (const { eventId, invite } of dead) {
          for (const lookup of [{ token: invite.token }, { code: invite.shortcode }]) {
            // The event's own Admin gets nothing either.
            await expect(invites.resolve(lookup, a.id)).resolves.toBeNull();
            await expect(invites.join(b.id, lookup, MAX_ACTIVE_GUESTS)).resolves.toEqual({
              outcome: 'dead',
            });
          }
          await expect(membershipRow(eventId, b.id)).resolves.toBeNull();
        }

        // Revoking the Guest Link leaves the Photographer Link live.
        await expect(
          invites.resolve({ token: revokedInvites.photographer.token }, null),
        ).resolves.toMatchObject({ role: 'photographer' });
      });

      it('lets a past event that is not archived be joined', async () => {
        const [a, b] = [await createNamedUser(), await createNamedUser()];
        const now = Date.now();
        const event = await createdEvent(
          a.id,
          request({
            venues: [{ name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 }],
            subEvents: [
              subEvent({
                name: 'Walima',
                startsAt: iso(now - 48 * HOUR),
                endsAt: iso(now - 44 * HOUR),
                venueIndex: 0,
              }),
            ],
          }),
        );
        const { guest } = await liveInvites(event.id);
        await expect(
          invites.join(b.id, { token: guest.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({ outcome: 'created', membership: { role: 'guest', status: 'active' } });
      });

      it("joins an auto event as active and a manual one as pending, with the link's role", async () => {
        const [a, g, p] = [
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
        ];
        const auto = await createdEvent(a.id);
        const manual = await createdEvent(a.id, request({ approvalMode: 'manual' }));
        const autoInvites = await liveInvites(auto.id);
        const manualInvites = await liveInvites(manual.id);

        await expect(
          invites.join(g.id, { token: autoInvites.guest.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({ outcome: 'created', membership: { role: 'guest', status: 'active' } });
        await expect(
          invites.join(p.id, { code: autoInvites.photographer.shortcode }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({
          outcome: 'created',
          membership: { role: 'photographer', status: 'active' },
        });
        await expect(
          invites.join(g.id, { token: manualInvites.guest.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({
          outcome: 'created',
          membership: { role: 'guest', status: 'pending' },
        });

        const row = await membershipRow(manual.id, g.id);
        expect(row).toMatchObject({ role: 'guest', status: 'pending', admin_verified_at: null });
        const requestedAt = Date.parse(row?.requested_at ?? '');
        expect(Math.abs(requestedAt - Date.now())).toBeLessThan(5 * 60 * 1000);

        await expect(store.listForMember(g.id)).resolves.toEqual([{ ...auto, role: 'guest' }]);
        await expect(store.listJoinRequests(g.id)).resolves.toEqual([
          {
            eventId: manual.id,
            eventName: 'RLS Test Wedding',
            role: 'guest',
            requestedAt: new Date(requestedAt).toISOString(),
          },
        ]);
      });

      it("returns a member's row unchanged on a repeat, whichever link they open", async () => {
        const [a, p, r] = [
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
        ];
        const event = await createdEvent(a.id);
        const { guest, photographer } = await liveInvites(event.id);
        await addMember(event.id, p.id, 'photographer', 'active');

        await expect(
          invites.join(a.id, { token: guest.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({ outcome: 'member', membership: { role: 'admin', status: 'active' } });
        await expect(
          invites.join(p.id, { token: guest.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({
          outcome: 'member',
          membership: { role: 'photographer', status: 'active' },
        });

        await setEvent(event.id, { approval_mode: 'manual' });
        await invites.join(r.id, { token: guest.token }, MAX_ACTIVE_GUESTS);
        const requested = await membershipRow(event.id, r.id);
        await setEvent(event.id, { approval_mode: 'auto' });
        await expect(
          invites.join(r.id, { token: photographer.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({ outcome: 'member', membership: { role: 'guest', status: 'pending' } });
        await expect(membershipRow(event.id, r.id)).resolves.toEqual(requested);
        await expect(membershipRow(event.id, a.id)).resolves.toMatchObject({ role: 'admin' });
        await expect(membershipRow(event.id, p.id)).resolves.toMatchObject({
          role: 'photographer',
        });
      });

      it('refuses a blocked person, and leaves their row as it was', async () => {
        const [a, b] = [await createNamedUser(), await createNamedUser()];
        const event = await createdEvent(a.id);
        const { guest, photographer } = await liveInvites(event.id);
        const inserted = await admin.from('membership').insert({
          event_id: event.id,
          user_id: b.id,
          role: 'guest',
          status: 'blocked',
          admin_verified_at: '2026-12-10T15:00:00.000Z',
        });
        expect(inserted.error).toBeNull();
        const before = await membershipRow(event.id, b.id);

        for (const lookup of [{ token: guest.token }, { code: photographer.shortcode }]) {
          await expect(invites.join(b.id, lookup, MAX_ACTIVE_GUESTS)).resolves.toEqual({
            outcome: 'blocked',
          });
        }
        await expect(membershipRow(event.id, b.id)).resolves.toEqual(before);
        await expect(invites.resolve({ token: guest.token }, b.id)).resolves.toMatchObject({
          membership: { role: 'guest', status: 'blocked' },
        });
      });

      it("lets a removed person rejoin by the approval mode, with the link's role and Force Verify cleared", async () => {
        const [a, b] = [await createNamedUser(), await createNamedUser()];
        const event = await createdEvent(a.id);
        const { guest, photographer } = await liveInvites(event.id);
        const inserted = await admin.from('membership').insert({
          event_id: event.id,
          user_id: b.id,
          role: 'guest',
          status: 'removed',
          admin_verified_at: '2026-12-10T15:00:00.000Z',
          requested_at: '2026-01-01T00:00:00.000Z',
        });
        expect(inserted.error).toBeNull();

        await expect(
          invites.join(b.id, { token: photographer.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({
          outcome: 'rejoined',
          membership: { role: 'photographer', status: 'active' },
        });
        const rejoined = await membershipRow(event.id, b.id);
        expect(rejoined).toMatchObject({
          role: 'photographer',
          status: 'active',
          admin_verified_at: null,
        });
        expect(Date.parse(rejoined?.requested_at ?? '')).toBeGreaterThan(
          Date.parse('2026-01-01T00:00:00.000Z'),
        );

        await admin
          .from('membership')
          .update({ status: 'removed' })
          .eq('event_id', event.id)
          .eq('user_id', b.id);
        await setEvent(event.id, { approval_mode: 'manual' });
        await expect(
          invites.join(b.id, { code: guest.shortcode }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({
          outcome: 'rejoined',
          membership: { role: 'guest', status: 'pending' },
        });
      });

      it('counts only active Guests toward the cap, and never caps a Photographer or a request', async () => {
        const [a, g1, x, g2, g3, p] = [
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
        ];
        const event = await createdEvent(a.id);
        const { guest, photographer } = await liveInvites(event.id);
        await addMember(event.id, g1.id, 'guest', 'active');
        await addMember(event.id, x.id, 'guest', 'pending');

        // A cap of 2: the Admin and the pending request do not count, so one place is left.
        await expect(invites.join(g2.id, { token: guest.token }, 2)).resolves.toMatchObject({
          outcome: 'created',
        });
        await expect(invites.join(g3.id, { token: guest.token }, 2)).resolves.toEqual({
          outcome: 'full',
        });
        await expect(membershipRow(event.id, g3.id)).resolves.toBeNull();
        await expect(invites.join(p.id, { token: photographer.token }, 2)).resolves.toEqual({
          outcome: 'created',
          membership: { role: 'photographer', status: 'active' },
        });

        // A manual event takes a request past the cap, which applies at approval (spec §4.17).
        await setEvent(event.id, { approval_mode: 'manual' });
        await expect(invites.join(g3.id, { token: guest.token }, 2)).resolves.toEqual({
          outcome: 'created',
          membership: { role: 'guest', status: 'pending' },
        });
        await expect(activeGuests(event.id)).resolves.toBe(2);
      });

      it('lets exactly one of two joins in when one place is left', async () => {
        const [a, g1, g2, g3] = [
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
        ];
        const event = await createdEvent(a.id);
        const { guest } = await liveInvites(event.id);
        await addMember(event.id, g1.id, 'guest', 'active');

        const results = await Promise.all([
          invites.join(g2.id, { token: guest.token }, 2),
          invites.join(g3.id, { code: guest.shortcode }, 2),
        ]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'full']);
        await expect(activeGuests(event.id)).resolves.toBe(2);
      });

      it('answers no_account for a user id with no account, and joins nothing', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const { guest } = await liveInvites(event.id);
        await expect(
          invites.join(randomUUID(), { token: guest.token }, MAX_ACTIVE_GUESTS),
        ).resolves.toEqual({ outcome: 'no_account' });
        const count = await admin
          .from('membership')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', event.id);
        expect(count.count).toBe(1);
      });

      it("cancels only the caller's own pending request, and leaves any other row alone", async () => {
        const [a, b, c] = [
          await createNamedUser(),
          await createNamedUser(),
          await createNamedUser(),
        ];
        const first = await createdEvent(a.id, request({ approvalMode: 'manual' }));
        const second = await createdEvent(a.id, request({ approvalMode: 'manual' }));
        const firstGuest = (await liveInvites(first.id)).guest;
        await invites.join(b.id, { token: firstGuest.token }, MAX_ACTIVE_GUESTS);
        await invites.join(c.id, { token: firstGuest.token }, MAX_ACTIVE_GUESTS);
        await invites.join(
          b.id,
          { token: (await liveInvites(second.id)).guest.token },
          MAX_ACTIVE_GUESTS,
        );

        await expect(invites.cancelJoinRequest(first.id, b.id)).resolves.toBeNull();
        await expect(membershipRow(first.id, b.id)).resolves.toBeNull();
        await expect(membershipRow(first.id, c.id)).resolves.toMatchObject({ status: 'pending' });
        await expect(membershipRow(second.id, b.id)).resolves.toMatchObject({ status: 'pending' });
        await expect(invites.cancelJoinRequest(first.id, b.id)).resolves.toBeNull();

        await expect(invites.cancelJoinRequest(first.id, a.id)).resolves.toEqual({
          role: 'admin',
          status: 'active',
        });

        // The Admin approved before the cancel arrived: the member stays.
        await admin
          .from('membership')
          .update({ status: 'active' })
          .eq('event_id', first.id)
          .eq('user_id', c.id);
        await expect(invites.cancelJoinRequest(first.id, c.id)).resolves.toEqual({
          role: 'guest',
          status: 'active',
        });
        await expect(membershipRow(first.id, c.id)).resolves.toMatchObject({ status: 'active' });
        await expect(invites.cancelJoinRequest(randomUUID(), b.id)).resolves.toBeNull();
      });

      it("lists the caller's own pending requests, and no active, blocked, removed or deleted one", async () => {
        const [a, b] = [await createNamedUser(), await createNamedUser()];
        const [pending, active, blocked, removed, deleted] = [
          await createdEvent(a.id, request({ name: 'Pending One' })),
          await createdEvent(a.id),
          await createdEvent(a.id),
          await createdEvent(a.id),
          await createdEvent(a.id),
        ];
        await addMember(pending.id, b.id, 'photographer', 'pending');
        await addMember(active.id, b.id, 'guest', 'active');
        await addMember(blocked.id, b.id, 'guest', 'blocked');
        await addMember(removed.id, b.id, 'guest', 'removed');
        await addMember(deleted.id, b.id, 'guest', 'pending');
        await setEvent(deleted.id, { deleted_at: new Date().toISOString() });

        const row = await membershipRow(pending.id, b.id);
        await expect(store.listJoinRequests(b.id)).resolves.toEqual([
          {
            eventId: pending.id,
            eventName: 'Pending One',
            role: 'photographer',
            requestedAt: new Date(row?.requested_at ?? '').toISOString(),
          },
        ]);
        await expect(store.listJoinRequests(a.id)).resolves.toEqual([]);
      });
    });

    describe('the schedule and sub-event writes', () => {
      const subEvents = createSubEventStore(admin);

      // The schedule, failing the test when the event has none to read.
      async function scheduleOf(eventId: string): Promise<SubEvent[]> {
        const schedule = await subEvents.schedule(eventId);
        if (schedule === null) {
          throw new Error(`no schedule for event ${eventId}`);
        }
        return schedule;
      }

      // The schedule a write answered with, failing the test when it answered a refusal.
      function written(result: { outcome: string; subEvents?: SubEvent[] }): SubEvent[] {
        if (result.subEvents === undefined) {
          throw new Error(`expected a schedule, got ${result.outcome}`);
        }
        return result.subEvents;
      }

      function named(schedule: SubEvent[], name: string): SubEvent {
        const subEvent = schedule.find((s) => s.name === name);
        if (subEvent === undefined) {
          throw new Error(`no sub-event named ${name}`);
        }
        return subEvent;
      }

      async function venuesOf(eventId: string) {
        const result = await admin
          .from('venue')
          .select('id, name, qr_secret')
          .eq('event_id', eventId)
          .order('name');
        expect(result.error).toBeNull();
        return (result.data ?? []) as { id: string; name: string; qr_secret: string }[];
      }

      async function countSubEvents(eventId: string) {
        const result = await admin
          .from('sub_event')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId);
        expect(result.error).toBeNull();
        return result.count;
      }

      async function softDelete(eventId: string) {
        const result = await admin
          .from('event')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', eventId);
        expect(result.error).toBeNull();
      }

      // A dholki the day before request()'s mehndi, unless the case sets its own fields.
      function addRequest(
        venue: VenueChoice,
        overrides: Partial<AddSubEventRequest> = {},
      ): AddSubEventRequest {
        return {
          requestId: randomUUID(),
          name: 'Dholki',
          startsAt: iso(T0 - 24 * HOUR),
          endsAt: iso(T0 - 20 * HOUR),
          venue,
          verificationRadiusM: VERIFICATION_RADIUS_DEFAULT_M,
          ...overrides,
        };
      }

      it('reads the schedule in order, each with its own radius and its venue, and never qr_secret', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const schedule = await scheduleOf(event.id);
        expect(
          schedule.map((s) => [
            s.name,
            s.description,
            s.startsAt,
            s.endsAt,
            s.verificationRadiusM,
            s.venue.name,
            s.venue.lat,
            s.venue.lng,
          ]),
        ).toEqual([
          [
            'Mehndi',
            'Yellow dress code',
            iso(T0),
            iso(T0 + 4 * HOUR),
            300,
            'Family Home',
            31.52,
            74.35,
          ],
          [
            'Baraat',
            null,
            iso(T0 + 24 * HOUR),
            iso(T0 + 30 * HOUR),
            150,
            'Pearl Continental',
            31.5546,
            74.3572,
          ],
          [
            'Walima',
            null,
            iso(T0 + 48 * HOUR),
            iso(T0 + 52 * HOUR),
            VERIFICATION_RADIUS_DEFAULT_M,
            'Pearl Continental',
            31.5546,
            74.3572,
          ],
        ]);
        // Two sub-events at one hall share its venue, and so its QR (spec §4.3).
        expect(named(schedule, 'Walima').venue.id).toBe(named(schedule, 'Baraat').venue.id);
        const venues = await venuesOf(event.id);
        expect(venues.map((v) => v.id).sort()).toEqual(
          [...new Set(schedule.map((s) => s.venue.id))].sort(),
        );

        const raw = await admin.rpc('sub_event_schedule', { p_event_id: event.id });
        expect(raw.error).toBeNull();
        expect(JSON.stringify(raw.data)).not.toMatch(/qr_?secret/i);
        for (const venue of venues) {
          expect(JSON.stringify(raw.data)).not.toContain(venue.qr_secret.replace(/^\\x/, ''));
        }

        await expect(subEvents.findEventId(named(schedule, 'Mehndi').id)).resolves.toBe(event.id);
        await expect(subEvents.findEventId(randomUUID())).resolves.toBeNull();
        await expect(subEvents.schedule(randomUUID())).resolves.toBeNull();
      });

      it('orders sub-events that start together by their end, then by id', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(
          a.id,
          request({
            subEvents: [
              subEvent({
                name: 'Long',
                startsAt: iso(T0),
                endsAt: iso(T0 + 6 * HOUR),
                venueIndex: 0,
              }),
              subEvent({
                name: 'Short',
                startsAt: iso(T0),
                endsAt: iso(T0 + 2 * HOUR),
                venueIndex: 1,
              }),
              subEvent({
                name: 'Twin A',
                startsAt: iso(T0),
                endsAt: iso(T0 + 4 * HOUR),
                venueIndex: 0,
              }),
              subEvent({
                name: 'Twin B',
                startsAt: iso(T0),
                endsAt: iso(T0 + 4 * HOUR),
                venueIndex: 0,
              }),
            ],
          }),
        );
        const schedule = await scheduleOf(event.id);
        // Postgres orders uuids as their lower-case strings sort.
        const twins = schedule
          .filter((s) => s.name.startsWith('Twin'))
          .sort((x, y) => (x.id < y.id ? -1 : 1));
        expect(schedule.map((s) => s.name)).toEqual(['Short', ...twins.map((s) => s.name), 'Long']);
      });

      it('adds at an existing venue and at a new one, and a repeated requestId adds nothing', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const hall = named(await scheduleOf(event.id), 'Baraat').venue;

        const atHall = addRequest({ id: hall.id }, { name: 'Nikah', description: '' });
        const added = await subEvents.add(event.id, atHall);
        expect(added.outcome).toBe('added');
        const nikah = named(written(added), 'Nikah');
        expect(nikah).toMatchObject({ description: null, venue: hall });
        expect(written(added).map((s) => s.name)).toEqual(['Nikah', 'Mehndi', 'Baraat', 'Walima']);

        // A retry after a lost answer: same requestId, whatever else it carries.
        const repeat = await subEvents.add(event.id, { ...atHall, name: 'Changed' });
        expect(repeat).toEqual({ outcome: 'repeated', subEvents: written(added) });
        await expect(countSubEvents(event.id)).resolves.toBe(4);

        const garden = await subEvents.add(
          event.id,
          addRequest(
            { name: 'Garden', lat: 31.7, lng: 74.5 },
            { name: 'Mayun', startsAt: iso(T0 - 48 * HOUR), endsAt: iso(T0 - 44 * HOUR) },
          ),
        );
        expect(named(written(garden), 'Mayun').venue).toMatchObject({
          name: 'Garden',
          lat: 31.7,
          lng: 74.5,
        });
        const venues = await venuesOf(event.id);
        expect(venues.map((v) => v.name)).toEqual(['Family Home', 'Garden', 'Pearl Continental']);
        // A new venue gets its own 32-byte QR secret, as one the wizard made does.
        const secret = venues.find((v) => v.name === 'Garden')?.qr_secret ?? '';
        expect(secret).toMatch(/^\\x[0-9a-f]{64}$/);

        // Another event's sub-event holds this requestId, and nothing about it comes back.
        const other = await createdEvent(a.id);
        const otherHall = named(await scheduleOf(other.id), 'Baraat').venue;
        await expect(
          subEvents.add(other.id, { ...atHall, venue: { id: otherHall.id } }),
        ).resolves.toEqual({ outcome: 'taken' });
        await expect(countSubEvents(other.id)).resolves.toBe(3);
      });

      it('refuses a 16th sub-event, lets one of two adds take the last place, and still finds a retried 15th', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const hall = named(await scheduleOf(event.id), 'Baraat').venue;
        const at = (i: number) =>
          addRequest(
            { id: hall.id },
            {
              name: `Extra ${i}`,
              startsAt: iso(T0 + i * HOUR),
              endsAt: iso(T0 + i * HOUR + HOUR / 2),
            },
          );
        for (let i = 4; i <= 14; i += 1) {
          await expect(subEvents.add(event.id, at(i))).resolves.toMatchObject({ outcome: 'added' });
        }
        await expect(countSubEvents(event.id)).resolves.toBe(14);

        const [first, second] = [at(15), at(16)];
        const results = await Promise.all([
          subEvents.add(event.id, first),
          subEvents.add(event.id, second),
        ]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['added', 'too_many']);
        await expect(countSubEvents(event.id)).resolves.toBe(15);

        await expect(subEvents.add(event.id, at(17))).resolves.toEqual({ outcome: 'too_many' });
        const winner = results[0].outcome === 'added' ? first : second;
        await expect(subEvents.add(event.id, winner)).resolves.toMatchObject({
          outcome: 'repeated',
        });
        await expect(countSubEvents(event.id)).resolves.toBe(15);
      });

      it('allows a span of exactly 336 hours and refuses one minute more, on an add and on an edit', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const schedule = await scheduleOf(event.id);
        const hall = named(schedule, 'Baraat').venue;
        const mehndi = named(schedule, 'Mehndi');
        const walima = named(schedule, 'Walima');
        // The event starts at T0, with the mehndi.
        const lastEnd = T0 + MAX_EVENT_SPAN_MS;

        await expect(
          subEvents.add(
            event.id,
            addRequest(
              { id: hall.id },
              { startsAt: iso(lastEnd - HOUR), endsAt: iso(lastEnd + 60_000) },
            ),
          ),
        ).resolves.toEqual({ outcome: 'too_long' });
        await expect(countSubEvents(event.id)).resolves.toBe(3);

        await expect(
          subEvents.update(event.id, walima.id, {
            startsAt: walima.startsAt,
            endsAt: iso(lastEnd + 60_000),
          }),
        ).resolves.toEqual({ outcome: 'too_long' });
        const added = await subEvents.add(
          event.id,
          addRequest({ id: hall.id }, { startsAt: iso(lastEnd - HOUR), endsAt: iso(lastEnd) }),
        );
        expect(added.outcome).toBe('added');
        // The span is now exactly 336 hours, so moving the first start one minute earlier passes it
        // from the other end.
        await expect(
          subEvents.update(event.id, mehndi.id, {
            startsAt: iso(T0 - 60_000),
            endsAt: mehndi.endsAt,
          }),
        ).resolves.toEqual({ outcome: 'too_long' });
        expect(named(await scheduleOf(event.id), 'Mehndi').startsAt).toBe(iso(T0));

        const edited = await subEvents.update(event.id, walima.id, {
          startsAt: iso(lastEnd - 2 * HOUR),
          endsAt: iso(lastEnd),
        });
        expect(named(written(edited), 'Walima').endsAt).toBe(iso(lastEnd));
      });

      it("refuses another event's venue on an add and on an edit, and changes nothing", async () => {
        const a = await createNamedUser();
        const [event, other] = [await createdEvent(a.id), await createdEvent(a.id)];
        const before = await scheduleOf(event.id);
        const foreign = named(await scheduleOf(other.id), 'Baraat').venue;

        await expect(subEvents.add(event.id, addRequest({ id: foreign.id }))).resolves.toEqual({
          outcome: 'no_venue',
        });
        await expect(
          subEvents.update(event.id, named(before, 'Mehndi').id, {
            name: 'Moved',
            venue: { id: foreign.id },
          }),
        ).resolves.toEqual({ outcome: 'no_venue' });
        await expect(subEvents.add(event.id, addRequest({ id: randomUUID() }))).resolves.toEqual({
          outcome: 'no_venue',
        });

        await expect(scheduleOf(event.id)).resolves.toEqual(before);
        await expect(venuesOf(event.id)).resolves.toHaveLength(2);
      });

      it('edits only the fields sent, clears an empty description, and deletes a venue it leaves unused', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const schedule = await scheduleOf(event.id);
        const mehndi = named(schedule, 'Mehndi');
        const hall = named(schedule, 'Baraat').venue;

        const renamed = named(
          written(await subEvents.update(event.id, mehndi.id, { name: 'Mayun' })),
          'Mayun',
        );
        expect(renamed).toEqual({ ...mehndi, name: 'Mayun' });

        const cleared = await subEvents.update(event.id, mehndi.id, { description: '' });
        expect(named(written(cleared), 'Mayun').description).toBeNull();

        // A Delay once it has started: the start stays and the end moves (D-121).
        const delayed = await subEvents.update(event.id, mehndi.id, {
          startsAt: mehndi.startsAt,
          endsAt: iso(T0 + 5 * HOUR),
        });
        expect(named(written(delayed), 'Mayun')).toMatchObject({
          startsAt: iso(T0),
          endsAt: iso(T0 + 5 * HOUR),
          verificationRadiusM: 300,
        });

        // Off the family home, which no other sub-event uses, so its venue goes.
        const moved = await subEvents.update(event.id, mehndi.id, {
          venue: { id: hall.id },
          verificationRadiusM: 500,
        });
        expect(named(written(moved), 'Mayun')).toMatchObject({
          venue: hall,
          verificationRadiusM: 500,
        });
        await expect(venuesOf(event.id)).resolves.toMatchObject([{ name: 'Pearl Continental' }]);

        // Off the hall to a new lawn: the hall stays, because two sub-events still use it.
        const lawn = await subEvents.update(event.id, mehndi.id, {
          venue: { name: 'Lawn', lat: 31.8, lng: 74.6 },
        });
        expect(named(written(lawn), 'Mayun').venue).toMatchObject({ name: 'Lawn' });
        await expect(venuesOf(event.id)).resolves.toMatchObject([
          { name: 'Lawn' },
          { name: 'Pearl Continental' },
        ]);

        // A sub-event of another event, reached through this one.
        const other = await createdEvent(a.id);
        const foreign = named(await scheduleOf(other.id), 'Mehndi');
        await expect(subEvents.update(event.id, foreign.id, { name: 'Hijack' })).resolves.toEqual({
          outcome: 'not_found',
        });
        expect(named(await scheduleOf(other.id), 'Mehndi')).toEqual(foreign);
      });

      it('deletes a sub-event and the venue it leaves unused, and never the last one', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const schedule = await scheduleOf(event.id);
        const mehndi = named(schedule, 'Mehndi');
        const baraat = named(schedule, 'Baraat');
        const walima = named(schedule, 'Walima');

        const first = await subEvents.remove(event.id, mehndi.id);
        expect(written(first).map((s) => s.name)).toEqual(['Baraat', 'Walima']);
        await expect(venuesOf(event.id)).resolves.toMatchObject([{ name: 'Pearl Continental' }]);
        // A retried delete finds nothing to delete.
        await expect(subEvents.remove(event.id, mehndi.id)).resolves.toEqual({
          outcome: 'not_found',
        });

        // The hall stays while the walima uses it.
        await subEvents.remove(event.id, baraat.id);
        await expect(venuesOf(event.id)).resolves.toHaveLength(1);
        await expect(subEvents.remove(event.id, walima.id)).resolves.toEqual({ outcome: 'last' });
        await expect(scheduleOf(event.id)).resolves.toEqual([walima]);

        const other = await createdEvent(a.id);
        const foreign = named(await scheduleOf(other.id), 'Mehndi');
        await expect(subEvents.remove(event.id, foreign.id)).resolves.toEqual({
          outcome: 'not_found',
        });
        await expect(countSubEvents(other.id)).resolves.toBe(3);
      });

      it('leaves one sub-event when deletes of the last two arrive at once', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const schedule = await scheduleOf(event.id);
        await subEvents.remove(event.id, named(schedule, 'Mehndi').id);

        const results = await Promise.all([
          subEvents.remove(event.id, named(schedule, 'Baraat').id),
          subEvents.remove(event.id, named(schedule, 'Walima').id),
        ]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['deleted', 'last']);
        await expect(countSubEvents(event.id)).resolves.toBe(1);
        // list_my_events still finds the event's span (D-121).
        await expect(store.listForMember(a.id)).resolves.toMatchObject([{ id: event.id }]);
      });

      it('refuses every write to a soft-deleted event, and reads no schedule for it', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const schedule = await scheduleOf(event.id);
        const mehndi = named(schedule, 'Mehndi');
        await softDelete(event.id);

        await expect(subEvents.schedule(event.id)).resolves.toBeNull();
        await expect(subEvents.add(event.id, addRequest({ id: mehndi.venue.id }))).resolves.toEqual(
          { outcome: 'not_found' },
        );
        await expect(subEvents.update(event.id, mehndi.id, { name: 'Late' })).resolves.toEqual({
          outcome: 'not_found',
        });
        await expect(subEvents.remove(event.id, mehndi.id)).resolves.toEqual({
          outcome: 'not_found',
        });
        await expect(countSubEvents(event.id)).resolves.toBe(3);
      });

      it('lets neither the publishable key nor a signed-in Admin call the four functions', async () => {
        const a = await createNamedUser();
        const event = await createdEvent(a.id);
        const before = await scheduleOf(event.id);
        const mehndi = named(before, 'Mehndi');
        const clients = [
          createServerClient(project.url, project.publishableKey),
          // The event's own Admin, who still writes nothing directly (root invariant 14).
          await signedInClient(a),
        ];

        for (const client of clients) {
          const read = await client.rpc('sub_event_schedule', { p_event_id: event.id });
          expect(read.error).not.toBeNull();
          expect(read.data).toBeNull();
          const add = await client.rpc(
            'add_sub_event',
            addSubEventParams(event.id, addRequest({ id: mehndi.venue.id })),
          );
          expect(add.error).not.toBeNull();
          const update = await client.rpc(
            'update_sub_event',
            updateSubEventParams(event.id, mehndi.id, { name: 'Changed' }),
          );
          expect(update.error).not.toBeNull();
          const remove = await client.rpc('delete_sub_event', {
            p_event_id: event.id,
            p_sub_event_id: mehndi.id,
          });
          expect(remove.error).not.toBeNull();
          const direct = await client
            .from('sub_event')
            .update({ create_request_id: randomUUID() })
            .eq('event_id', event.id);
          expect(direct.error).not.toBeNull();
        }

        await expect(scheduleOf(event.id)).resolves.toEqual(before);
        const stamped = await admin
          .from('sub_event')
          .select('id')
          .eq('event_id', event.id)
          .not('create_request_id', 'is', null);
        expect(stamped.data).toEqual([]);
      });
    });
  });
}
