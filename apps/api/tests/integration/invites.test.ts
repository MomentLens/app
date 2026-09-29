// POST /invites/resolve, POST /invites/join and DELETE /events/{eventId}/join-request (D-115,
// arch:invite, arch:membership). The invite store is an in-memory fake that answers as
// resolve_invite, join_event and the cancel do, so these tests check what the API asks the store
// for and what it does with each answer. rls.test.ts runs the real store and both functions against
// the dev project, where the cap, the lock and the dead-invite rules actually live.
import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  CancelJoinRequestResponse,
  ErrorResponse,
  JoinEventResponse,
  ResolveInviteResponse,
  SHORTCODE_ALPHABET,
} from '@momentlens/shared-types';
import type {
  ApprovalMode,
  InviteLookup,
  InviteRole,
  Membership,
  MembershipRole,
  MembershipStatus,
} from '@momentlens/shared-types';

import type { AppDeps } from '../../src/app';
import type { VerifyToken } from '../../src/middleware/auth';
import { MAX_ACTIVE_GUESTS } from '../../src/services/invites';
import type { InvitePreviewRecord, InviteStore, JoinResult } from '../../src/services/invites';
import { startApp, TEST_R2, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const A = randomUUID();
const B = randomUUID();

const tokens = new Map([
  ['token-a', A],
  ['token-b', B],
]);

// token-down stands for a token the API could not check because Auth was unreachable.
const verifyToken: VerifyToken = (token) => {
  if (token === 'token-down') {
    return Promise.reject(new Error('Auth unreachable'));
  }
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

interface FakeMember {
  role: MembershipRole;
  status: MembershipStatus;
  adminVerifiedAt: string | null;
}

interface FakeEvent {
  id: string;
  name: string;
  coverKey: string | null;
  startsAt: string;
  endsAt: string;
  venueNames: string[];
  approvalMode: ApprovalMode;
  deleted: boolean;
  archived: boolean;
  members: Map<string, FakeMember>;
  // Columns the real rows have and no response may carry, to check the API drops them.
  qrSecret: string;
  lat: number;
  lng: number;
}

interface FakeInvite {
  token: string;
  code: string;
  eventId: string;
  role: InviteRole;
  revoked: boolean;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function newCode(): string {
  return Array.from(randomBytes(6), (byte) => SHORTCODE_ALPHABET[byte % 31]).join('');
}

// Answers as resolve_invite, join_event and the cancel do. An invite is dead once revoked or once
// its event is deleted or archived (arch:invite). A join checks the invite, then a block, then the
// cap on active Guests, and a repeat returns the row unchanged (arch:membership).
class FakeInvites implements InviteStore {
  readonly events = new Map<string, FakeEvent>();
  readonly invites: FakeInvite[] = [];
  readonly resolves: { lookup: InviteLookup; userId: string | null }[] = [];
  readonly joins: { userId: string; lookup: InviteLookup; maxGuests: number }[] = [];
  readonly cancels: { eventId: string; userId: string }[] = [];
  failWith: Error | null = null;
  unknownUsers = new Set<string>();

  seed(
    members: Record<string, [MembershipRole, MembershipStatus]>,
    extra: Partial<FakeEvent> = {},
  ) {
    const event: FakeEvent = {
      id: randomUUID(),
      name: 'Ayesha & Bilal',
      coverKey: null,
      startsAt: '2026-12-10T14:00:00.000Z',
      endsAt: '2026-12-12T18:00:00.000Z',
      venueNames: ['Family Home', 'Pearl Continental'],
      approvalMode: 'auto',
      deleted: false,
      archived: false,
      members: new Map(
        Object.entries(members).map(([user, [role, status]]) => [
          user,
          { role, status, adminVerifiedAt: null },
        ]),
      ),
      qrSecret: 'c2VjcmV0LXNob3VsZC1uZXZlci1sZWF2ZQ',
      lat: 31.5546,
      lng: 74.3572,
      ...extra,
    };
    this.events.set(event.id, event);
    const guest = this.addInvite(event.id, 'guest');
    const photographer = this.addInvite(event.id, 'photographer');
    return { event, guest, photographer };
  }

  addInvite(eventId: string, role: InviteRole): FakeInvite {
    const invite = { token: newToken(), code: newCode(), eventId, role, revoked: false };
    this.invites.push(invite);
    return invite;
  }

  private live(lookup: InviteLookup) {
    const invite = this.invites.find((i) =>
      'token' in lookup ? i.token === lookup.token : i.code === lookup.code,
    );
    const event = invite && this.events.get(invite.eventId);
    if (invite === undefined || event === undefined) return null;
    if (invite.revoked || event.deleted || event.archived) return null;
    return { invite, event };
  }

  resolve(lookup: InviteLookup, userId: string | null): Promise<InvitePreviewRecord | null> {
    this.resolves.push({ lookup, userId });
    if (this.failWith) return Promise.reject(this.failWith);
    const found = this.live(lookup);
    if (found === null) return Promise.resolve(null);
    const { invite, event } = found;
    const member = userId === null ? undefined : event.members.get(userId);
    // Cast: the real store's row parse drops every column the record does not name, and this
    // record carries some anyway to check the API drops them too.
    return Promise.resolve({
      role: invite.role,
      event: {
        id: event.id,
        name: event.name,
        coverKey: event.coverKey,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        venueNames: event.venueNames,
        qrSecret: event.qrSecret,
        venues: event.venueNames.map((name) => ({ name, lat: event.lat, lng: event.lng })),
        members: [...event.members.keys()],
      },
      membership: member === undefined ? null : { role: member.role, status: member.status },
    } as InvitePreviewRecord);
  }

  join(userId: string, lookup: InviteLookup, maxGuests: number): Promise<JoinResult> {
    this.joins.push({ userId, lookup, maxGuests });
    if (this.failWith) return Promise.reject(this.failWith);
    const found = this.live(lookup);
    if (found === null) return Promise.resolve({ outcome: 'dead' });
    const { invite, event } = found;
    const member = event.members.get(userId);
    if (member?.status === 'active' || member?.status === 'pending') {
      return Promise.resolve({
        outcome: 'member',
        membership: { role: member.role, status: member.status },
      });
    }
    if (member?.status === 'blocked') return Promise.resolve({ outcome: 'blocked' });
    if (this.unknownUsers.has(userId)) return Promise.resolve({ outcome: 'no_account' });
    const status = event.approvalMode === 'auto' ? 'active' : 'pending';
    const guests = [...event.members.values()].filter(
      (m) => m.role === 'guest' && m.status === 'active',
    ).length;
    if (status === 'active' && invite.role === 'guest' && guests >= maxGuests) {
      return Promise.resolve({ outcome: 'full' });
    }
    event.members.set(userId, { role: invite.role, status, adminVerifiedAt: null });
    return Promise.resolve({
      outcome: member === undefined ? 'created' : 'rejoined',
      membership: { role: invite.role, status },
    });
  }

  cancelJoinRequest(eventId: string, userId: string): Promise<Membership | null> {
    this.cancels.push({ eventId, userId });
    if (this.failWith) return Promise.reject(this.failWith);
    const event = this.events.get(eventId);
    const member = event?.members.get(userId);
    if (event === undefined || member === undefined) return Promise.resolve(null);
    if (member.status === 'pending') {
      event.members.delete(userId);
      return Promise.resolve(null);
    }
    return Promise.resolve({ role: member.role, status: member.status });
  }
}

let store: FakeInvites;
let app: RunningApp;

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return testDeps({ verifyToken, invites: store, ...overrides });
}

beforeAll(async () => {
  store = new FakeInvites();
  app = await startApp(deps());
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.events.clear();
  store.invites.length = 0;
  store.resolves.length = 0;
  store.joins.length = 0;
  store.cancels.length = 0;
  store.failWith = null;
  store.unknownUsers.clear();
});

function send(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${app.baseUrl}${path}`, init);
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

function member(eventId: string, userId: string): FakeMember | undefined {
  return store.events.get(eventId)?.members.get(userId);
}

describe('POST /invites/resolve', () => {
  it('previews a live invite to a caller with no session, with no membership', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'] });
    const response = await send('POST', '/invites/resolve', undefined, { token: guest.token });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(ResolveInviteResponse.parse(await response.json())).toEqual({
      role: 'guest',
      event: {
        id: event.id,
        name: 'Ayesha & Bilal',
        cover: null,
        startsAt: '2026-12-10T14:00:00.000Z',
        endsAt: '2026-12-12T18:00:00.000Z',
        venueNames: ['Family Home', 'Pearl Continental'],
      },
      membership: null,
    });
    expect(store.resolves).toEqual([{ lookup: { token: guest.token }, userId: null }]);
  });

  it("gives a signed-in caller their own membership and never another member's", async () => {
    const { photographer } = store.seed({ [B]: ['admin', 'active'] });
    const stranger = ResolveInviteResponse.parse(
      await (
        await send('POST', '/invites/resolve', 'token-a', { token: photographer.token })
      ).json(),
    );
    expect(stranger.role).toBe('photographer');
    expect(stranger.membership).toBeNull();
    expect(store.resolves.at(-1)?.userId).toBe(A);

    const admin = ResolveInviteResponse.parse(
      await (
        await send('POST', '/invites/resolve', 'token-b', { token: photographer.token })
      ).json(),
    );
    expect(admin.membership).toEqual({ role: 'admin', status: 'active' });
  });

  it.each(['pending', 'blocked', 'removed'] as const)(
    'tells a %s caller where they stand, so the app routes on it',
    async (status) => {
      const { guest } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', status] });
      const response = await send('POST', '/invites/resolve', 'token-a', { token: guest.token });
      expect(response.status).toBe(200);
      expect(ResolveInviteResponse.parse(await response.json()).membership).toEqual({
        role: 'guest',
        status,
      });
    },
  );

  it('resolves a code typed in mixed case with spaces, and asks the store for the stored form', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'] });
    guest.code = 'AB3K7X';
    const response = await send('POST', '/invites/resolve', undefined, { code: ' ab3 K7x ' });
    expect(response.status).toBe(200);
    expect(ResolveInviteResponse.parse(await response.json()).event.id).toBe(event.id);
    expect(store.resolves).toEqual([{ lookup: { code: 'AB3K7X' }, userId: null }]);
  });

  describe('answers 404 not_found for a dead invite', () => {
    it('an unknown token', async () => {
      store.seed({ [B]: ['admin', 'active'] });
      const response = await send('POST', '/invites/resolve', 'token-a', { token: newToken() });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    });

    it('an unknown code', async () => {
      store.seed({ [B]: ['admin', 'active'] });
      const response = await send('POST', '/invites/resolve', undefined, { code: 'ZZZZZZ' });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    });

    it('a revoked invite, by token and by code', async () => {
      const { guest } = store.seed({ [B]: ['admin', 'active'] });
      guest.revoked = true;
      for (const body of [{ token: guest.token }, { code: guest.code }]) {
        const response = await send('POST', '/invites/resolve', 'token-a', body);
        expect(response.status).toBe(404);
        expect(await errorCode(response)).toBe('not_found');
      }
    });

    it.each([
      ['a deleted event', { deleted: true }],
      ['an archived event', { archived: true }],
    ])("%s, to the event's own Admin too", async (_, extra) => {
      const { guest } = store.seed({ [A]: ['admin', 'active'] }, extra);
      const response = await send('POST', '/invites/resolve', 'token-a', { token: guest.token });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    });
  });

  it('sends no member, no venue position and no QR secret, whatever the store row carries', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'active'] });
    const text = await (
      await send('POST', '/invites/resolve', 'token-a', { token: guest.token })
    ).text();
    expect(text).not.toContain(event.qrSecret);
    expect(text.toLowerCase()).not.toContain('qr');
    expect(text).not.toContain(String(event.lat));
    expect(text).not.toContain(String(event.lng));
    expect(text).not.toContain(B);
    expect(text).not.toContain('"members"');
    expect(text).not.toContain('"venues"');
    expect(text).not.toContain(guest.token);
    expect(text).not.toContain(guest.code);
  });

  it('presigns the cover for any invite holder, cached by its key, never a bucket URL', async () => {
    const eventId = randomUUID();
    const key = `events/${eventId}/cover_${randomUUID()}.jpg`;
    const { guest } = store.seed({ [B]: ['admin', 'active'] }, { id: eventId, coverKey: key });

    const { event } = ResolveInviteResponse.parse(
      await (await send('POST', '/invites/resolve', undefined, { token: guest.token })).json(),
    );
    expect(event.cover?.cacheKey).toBe(key);
    const url = new URL(event.cover?.url ?? '');
    expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('answers 401 no_session for an Authorization header that is not a valid session', () => {
    it.each([
      ['an unknown token', 'Bearer token-z'],
      ['another scheme', 'Basic dXNlcjpwYXNz'],
      ['an empty header', ''],
      ['a bare scheme', 'Bearer'],
    ])('%s, and never falls back to a signed-out preview', async (_, authorization) => {
      const { guest } = store.seed({ [B]: ['admin', 'active'] });
      const response = await send(
        'POST',
        '/invites/resolve',
        undefined,
        { token: guest.token },
        { Authorization: authorization },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await errorCode(response)).toBe('no_session');
      expect(store.resolves).toEqual([]);
    });
  });

  it('answers 500 rather than a signed-out preview when Auth could not check the token', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] });
    const response = await send('POST', '/invites/resolve', 'token-down', { token: guest.token });
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('internal_error');
    expect(store.resolves).toEqual([]);
  });

  describe('refuses a body that does not name exactly one invite with 400 invalid_request', () => {
    it.each([
      ['no body', undefined],
      ['an empty object', {}],
      ['a token and a code', { token: newToken(), code: 'AB3K7X' }],
      ['a token 42 characters long', { token: newToken().slice(1) }],
      ['a token with a character outside base64url', { token: `${newToken().slice(1)}+` }],
      ['a code with a letter the alphabet leaves out', { code: 'AB3K7O' }],
      ['a code 7 characters long', { code: 'AB3K7XY' }],
      ['a token beside a user id', { token: newToken(), userId: B }],
      ['an event id instead of an invite', { eventId: randomUUID() }],
    ])('%s', async (_, body) => {
      const response = await send('POST', '/invites/resolve', 'token-a', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
      expect(store.resolves).toEqual([]);
    });
  });

  it('answers 500 internal_error, naming no cause, when the store fails', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] });
    store.failWith = new Error('connection reset by the database');
    const response = await send('POST', '/invites/resolve', undefined, { token: guest.token });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('connection reset');
  });

  it('answers 500 rather than send a stored name the contract rejects', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] }, { name: '   ' });
    const response = await send('POST', '/invites/resolve', undefined, { token: guest.token });
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('internal_error');
  });
});

describe('POST /invites/join', () => {
  it('answers 401 no_session with no token, and asks the store nothing', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] });
    const response = await send('POST', '/invites/join', undefined, { token: guest.token });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
    expect(store.joins).toEqual([]);
  });

  it('joins an auto event as an active Guest with 201, for the caller in the token', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'] });
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JoinEventResponse.parse(await response.json())).toEqual({
      membership: { role: 'guest', status: 'active' },
    });
    expect(store.joins).toEqual([
      { userId: A, lookup: { token: guest.token }, maxGuests: MAX_ACTIVE_GUESTS },
    ]);
    expect(member(event.id, A)?.status).toBe('active');
  });

  it('caps active Guests at 150, the number the join above passed (spec §4.17, D-102)', () => {
    expect(MAX_ACTIVE_GUESTS).toBe(150);
  });

  it('joins through the Photographer Link as a Photographer', async () => {
    const { photographer } = store.seed({ [B]: ['admin', 'active'] });
    const response = await send('POST', '/invites/join', 'token-a', { code: photographer.code });
    expect(response.status).toBe(201);
    expect(JoinEventResponse.parse(await response.json()).membership).toEqual({
      role: 'photographer',
      status: 'active',
    });
  });

  it('holds a join to a manual event as pending', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] }, { approvalMode: 'manual' });
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(201);
    expect(JoinEventResponse.parse(await response.json()).membership).toEqual({
      role: 'guest',
      status: 'pending',
    });
  });

  it('answers 404 not_found for a dead invite, and joins nothing', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'] });
    guest.revoked = true;
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
    expect(member(event.id, A)).toBeUndefined();
  });

  it('answers 403 blocked to a blocked person, and leaves the row as it was', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'blocked'] });
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('blocked');
    expect(member(event.id, A)).toEqual({
      role: 'guest',
      status: 'blocked',
      adminVerifiedAt: null,
    });
  });

  it.each([
    ['the Admin', 'admin'],
    ['a Photographer', 'photographer'],
  ] as const)('keeps %s on the Guest Link in their role, with 200', async (_, role) => {
    const { event, guest } = store.seed({ [A]: [role, 'active'] });
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(200);
    expect(JoinEventResponse.parse(await response.json()).membership).toEqual({
      role,
      status: 'active',
    });
    expect(member(event.id, A)?.role).toBe(role);
  });

  it('returns a pending request unchanged with 200 when it repeats, the mode now auto too', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] });
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(200);
    expect(JoinEventResponse.parse(await response.json()).membership.status).toBe('pending');
  });

  it("lets a removed person rejoin with the link's role, with 200", async () => {
    const { event, photographer } = store.seed({
      [B]: ['admin', 'active'],
      [A]: ['guest', 'removed'],
    });
    const response = await send('POST', '/invites/join', 'token-a', { token: photographer.token });
    expect(response.status).toBe(200);
    expect(JoinEventResponse.parse(await response.json()).membership).toEqual({
      role: 'photographer',
      status: 'active',
    });
    expect(member(event.id, A)?.role).toBe('photographer');
  });

  it('answers 422 event_full to the 151st active Guest, and lets a Photographer past 150 in', async () => {
    const guests = Object.fromEntries(
      Array.from({ length: MAX_ACTIVE_GUESTS }, () => [randomUUID(), ['guest', 'active']]),
    ) as Record<string, [MembershipRole, MembershipStatus]>;
    const { event, guest, photographer } = store.seed({ [B]: ['admin', 'active'], ...guests });

    const full = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(full.status).toBe(422);
    expect(await errorCode(full)).toBe('event_full');
    expect(member(event.id, A)).toBeUndefined();

    const past = await send('POST', '/invites/join', 'token-a', { token: photographer.token });
    expect(past.status).toBe(201);
    expect(JoinEventResponse.parse(await past.json()).membership.role).toBe('photographer');
  });

  it('answers 401 no_session when the account was deleted after the token was issued', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] });
    store.unknownUsers.add(A);
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
  });

  it('refuses a body naming a user, since the caller comes from the token only', async () => {
    const { event, guest } = store.seed({ [B]: ['admin', 'active'] });
    const response = await send('POST', '/invites/join', 'token-a', {
      token: guest.token,
      userId: randomUUID(),
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
    expect(store.joins).toEqual([]);
    expect(member(event.id, A)).toBeUndefined();
  });

  it('refuses a body that is not JSON with 400 invalid_request', async () => {
    const response = await send('POST', '/invites/join', 'token-a', '{"token":');
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
  });

  it('answers 500 internal_error, naming no cause, when the store fails', async () => {
    const { guest } = store.seed({ [B]: ['admin', 'active'] });
    store.failWith = new Error('connection reset by the database');
    const response = await send('POST', '/invites/join', 'token-a', { token: guest.token });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('connection reset');
  });
});

describe('DELETE /events/{eventId}/join-request', () => {
  it('answers 401 no_session with no token, and deletes nothing', async () => {
    const { event } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] });
    const response = await send('DELETE', `/events/${event.id}/join-request`);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
    expect(store.cancels).toEqual([]);
    expect(member(event.id, A)?.status).toBe('pending');
  });

  it("deletes the caller's own pending request and answers a null membership", async () => {
    const { event } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] });
    const response = await send('DELETE', `/events/${event.id}/join-request`, 'token-a');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(CancelJoinRequestResponse.parse(await response.json())).toEqual({ membership: null });
    expect(store.cancels).toEqual([{ eventId: event.id, userId: A }]);
    expect(member(event.id, A)).toBeUndefined();
  });

  it("deletes only B's request when B cancels, and leaves A's in the same event", async () => {
    const { event } = store.seed({
      [randomUUID()]: ['admin', 'active'],
      [A]: ['guest', 'pending'],
      [B]: ['photographer', 'pending'],
    });
    const response = await send('DELETE', `/events/${event.id}/join-request`, 'token-b');
    expect(response.status).toBe(200);
    expect(CancelJoinRequestResponse.parse(await response.json())).toEqual({ membership: null });
    expect(store.cancels).toEqual([{ eventId: event.id, userId: B }]);
    expect(member(event.id, B)).toBeUndefined();
    expect(member(event.id, A)?.status).toBe('pending');
  });

  it("leaves the Admin's row alone when the Admin cancels in their own event", async () => {
    const { event } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] });
    const response = await send('DELETE', `/events/${event.id}/join-request`, 'token-b');
    expect(CancelJoinRequestResponse.parse(await response.json())).toEqual({
      membership: { role: 'admin', status: 'active' },
    });
    expect(member(event.id, A)?.status).toBe('pending');
  });

  it('leaves an active row alone and returns it, as when the Admin approved first', async () => {
    const { event } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'active'] });
    const response = await send('DELETE', `/events/${event.id}/join-request`, 'token-a');
    expect(response.status).toBe(200);
    expect(CancelJoinRequestResponse.parse(await response.json())).toEqual({
      membership: { role: 'guest', status: 'active' },
    });
    expect(member(event.id, A)?.status).toBe('active');
  });

  it("leaves the caller's request in another event alone", async () => {
    const mine = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] }).event;
    const other = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] }).event;
    const response = await send('DELETE', `/events/${other.id}/join-request`, 'token-a');
    expect(response.status).toBe(200);
    expect(member(other.id, A)).toBeUndefined();
    expect(member(mine.id, A)?.status).toBe('pending');
  });

  it('answers a null membership, not an error, for an event the caller never asked to join', async () => {
    const response = await send('DELETE', `/events/${randomUUID()}/join-request`, 'token-a');
    expect(response.status).toBe(200);
    expect(CancelJoinRequestResponse.parse(await response.json())).toEqual({ membership: null });
  });

  it('treats an uppercase event id as the same event', async () => {
    const { event } = store.seed({ [B]: ['admin', 'active'], [A]: ['guest', 'pending'] });
    await send('DELETE', `/events/${event.id.toUpperCase()}/join-request`, 'token-a');
    expect(store.cancels).toEqual([{ eventId: event.id, userId: A }]);
    expect(member(event.id, A)).toBeUndefined();
  });

  it('answers 400 invalid_request for an event id that is not a uuid', async () => {
    const response = await send('DELETE', '/events/not-a-uuid/join-request', 'token-a');
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
    expect(store.cancels).toEqual([]);
  });
});
