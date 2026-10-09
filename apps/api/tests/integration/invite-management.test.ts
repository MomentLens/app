import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  ErrorResponse,
  ListInvitesResponse,
  RegenerateInviteResponse,
} from '@momentlens/shared-types';
import type { InviteRole, Membership } from '@momentlens/shared-types';

import type { Supabase } from '../../src/db/supabase';
import { createInviteManagementStore } from '../../src/services/invites';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const ADMIN = randomUUID();
const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const users = new Map<string, Membership | null>([
  [ADMIN, { role: 'admin', status: 'active' }],
  ['other-admin', null],
  ['guest', { role: 'guest', status: 'active' }],
  ['photographer', { role: 'photographer', status: 'active' }],
  ['pending', { role: 'guest', status: 'pending' }],
  ['blocked', { role: 'guest', status: 'blocked' }],
  ['removed', { role: 'guest', status: 'removed' }],
  ['non-member', null],
]);

function credential(role: InviteRole) {
  return {
    id: randomUUID(),
    role,
    token: randomBytes(32).toString('base64url'),
    shortcode: 'AB3K7X',
  };
}

// These outcomes model the RPC's boundary. rls.test.ts checks its access rules and writes
// against PostgreSQL; these requests check auth, parsing and the HTTP mapping.
const rpc = jest.fn<(name: string, params: Record<string, unknown>) => Promise<unknown>>();
let credentials: ReturnType<typeof credential>[];
let reply: unknown;
let deleted: boolean;
let app: RunningApp;

beforeAll(async () => {
  app = await startApp(
    testDeps({
      verifyToken: (token) => Promise.resolve(users.has(token) ? { id: token } : null),
      inviteManagement: createInviteManagementStore({ rpc } as unknown as Supabase),
    }),
  );
});
afterAll(async () => {
  if (app) await app.close();
});
beforeEach(() => {
  credentials = [credential('guest'), { ...credential('photographer'), shortcode: 'CD4N8Y' }];
  reply = undefined;
  deleted = false;
  rpc.mockReset();
  rpc.mockImplementation((name, params) => {
    let data: unknown;
    const member = users.get(String(params.p_actor_id));
    if (params.p_event_id !== EVENT || deleted) data = { outcome: 'not_found' };
    else if (member?.status !== 'active') data = { outcome: 'not_member' };
    else if (member.role !== 'admin') data = { outcome: 'wrong_role' };
    else if (reply !== undefined) data = reply;
    else if (name === 'list_event_invites') data = { outcome: 'listed', invites: credentials };
    else {
      const current = credentials.find((i) => i.role === params.p_role);
      if (current === undefined || current.id !== params.p_expected_invite_id)
        data = { outcome: 'invite_changed' };
      else {
        const next = credential(current.role);
        credentials = credentials.map((i) => (i.role === next.role ? next : i));
        data = { outcome: 'regenerated', invite: next };
      }
    }
    return Promise.resolve({ data, error: null });
  });
});

function send(
  method: string,
  token: string | null = ADMIN,
  body?: unknown,
  eventId: string = EVENT,
) {
  return fetch(
    `${app.baseUrl}/events/${eventId}/invites${method === 'POST' ? '/regenerate' : ''}`,
    {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
const rotation = () => {
  const guest = credentials.find((invite) => invite.role === 'guest');
  if (guest === undefined) throw new Error('Missing Guest fixture');
  return { role: 'guest', expectedInviteId: guest.id };
};
async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(ErrorResponse.parse(await response.json()).error.code).toBe(code);
}

describe.each(['GET', 'POST'])('%s invite management', (method) => {
  it.each(['other-admin', 'guest', 'photographer', 'pending', 'blocked', 'removed', 'non-member'])(
    'refuses %s without credentials or writes',
    async (actor) => {
      const before = structuredClone(credentials);
      await refused(
        await send(method, actor, method === 'POST' ? rotation() : undefined),
        403,
        actor === 'guest' || actor === 'photographer' ? 'wrong_role' : 'not_member',
      );
      expect(credentials).toEqual(before);
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, 'expired-token'])('refuses session %s before calling the RPC', async (token) => {
    await refused(
      await send(method, token, method === 'POST' ? rotation() : undefined),
      401,
      'no_session',
    );
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses an Admin asking for another event', async () => {
    await refused(
      await send(method, ADMIN, method === 'POST' ? rotation() : undefined, OTHER_EVENT),
      404,
      'not_found',
    );
  });
  it('refuses a deleted event', async () => {
    deleted = true;
    await refused(
      await send(method, ADMIN, method === 'POST' ? rotation() : undefined),
      404,
      'not_found',
    );
  });
  it('rejects a malformed event id before calling the RPC', async () => {
    await refused(
      await send(method, ADMIN, method === 'POST' ? rotation() : undefined, 'bad-id'),
      400,
      'invalid_request',
    );
    expect(rpc).not.toHaveBeenCalled();
  });
  it('turns a database failure into internal_error without retrying', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('RPC failed') });
    await refused(
      await send(method, ADMIN, method === 'POST' ? rotation() : undefined),
      500,
      'internal_error',
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

it('lists both current roles with no-store and no images or private fields', async () => {
  reply = {
    outcome: 'listed',
    invites: credentials.map((i) => ({
      ...i,
      faces: ['private'],
      image: 'private',
      event_id: EVENT,
    })),
  };
  const response = await send('GET');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body: unknown = await response.json();
  expect(body).toEqual({
    invites: credentials.map(({ shortcode, ...i }) => ({ ...i, code: shortcode })),
  });
  expect(ListInvitesResponse.safeParse(body).success).toBe(true);
  expect(rpc).toHaveBeenCalledWith('list_event_invites', { p_event_id: EVENT, p_actor_id: ADMIN });
});

it.each(['missing', 'duplicate', 'malformed', 'internal_error', 'unknown'])(
  'refuses %s list data without repair',
  async (kind) => {
    reply =
      kind === 'internal_error'
        ? { outcome: 'internal_error' }
        : kind === 'unknown'
          ? { outcome: 'new_outcome' }
          : {
              outcome: 'listed',
              invites:
                kind === 'missing'
                  ? credentials.slice(0, 1)
                  : kind === 'duplicate'
                    ? [credentials[0], credentials[0]]
                    : [{ ...credentials[0], token: 'bad' }, credentials[1]],
            };
    await refused(await send('GET'), 500, 'internal_error');
    expect(rpc).toHaveBeenCalledTimes(1);
  },
);

it.each(['guest', 'photographer'] as const)(
  'regenerates %s using the authenticated actor and expected id',
  async (role) => {
    const old = credentials.find((i) => i.role === role)!;
    const response = await send('POST', ADMIN, { role, expectedInviteId: old.id });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = RegenerateInviteResponse.parse(await response.json());
    expect(body.invite.id).not.toBe(old.id);
    expect(body.invite.role).toBe(role);
    expect(rpc).toHaveBeenCalledWith('regenerate_event_invite', {
      p_event_id: EVENT,
      p_actor_id: ADMIN,
      p_role: role,
      p_expected_invite_id: old.id,
    });
  },
);

it.each([
  {},
  { role: 'admin', expectedInviteId: randomUUID() },
  { role: 'guest', expectedInviteId: 'bad' },
  { role: 'guest', expectedInviteId: randomUUID(), actorId: 'other-admin' },
  null,
])('rejects a malformed rotation body %j before the RPC', async (body) => {
  await refused(await send('POST', ADMIN, body), 400, 'invalid_request');
  expect(rpc).not.toHaveBeenCalled();
});

it('returns invite_changed for a stale id without replacing the new invite', async () => {
  const request = rotation();
  expect((await send('POST', ADMIN, request)).status).toBe(200);
  const next = structuredClone(credentials);
  await refused(await send('POST', ADMIN, request), 409, 'invite_changed');
  expect(credentials).toEqual(next);
});

it('refuses a replacement for the wrong role before exposing credentials', async () => {
  reply = { outcome: 'regenerated', invite: credentials[1] };
  await refused(await send('POST', ADMIN, rotation()), 500, 'internal_error');
});

it('strips image and face fields from a replacement response', async () => {
  const invite = credential('guest');
  reply = { outcome: 'regenerated', invite: { ...invite, faces: ['private'], image: 'private' } };
  const response = await send('POST', ADMIN, rotation());
  expect(response.status).toBe(200);
  const { shortcode, ...fields } = invite;
  expect(await response.json()).toEqual({ invite: { ...fields, code: shortcode } });
});
