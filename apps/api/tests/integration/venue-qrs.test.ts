import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { pino } from 'pino';

import {
  ErrorResponse,
  ListVenueQrsResponse,
  RegenerateVenueQrResponse,
} from '@momentlens/shared-types';
import type { Membership } from '@momentlens/shared-types';

import type { Supabase } from '../../src/db/supabase';
import { createVenueQrStore } from '../../src/services/venue-qrs';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const ADMIN = randomUUID();
const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const VENUE = randomUUID();
const OTHER_VENUE = randomUUID();
const users = new Map<string, Membership | null>([
  [ADMIN, { role: 'admin', status: 'active' }],
  ['other-admin', null],
  ['guest', { role: 'guest', status: 'active' }],
  ['photographer', { role: 'photographer', status: 'active' }],
  ['pending', { role: 'admin', status: 'pending' }],
  ['blocked', { role: 'admin', status: 'blocked' }],
  ['removed', { role: 'admin', status: 'removed' }],
  ['non-member', null],
]);

function credential(venueId = VENUE) {
  return { venue_id: venueId, venue_name: 'Hall', secret: randomBytes(32).toString('hex') };
}
function managed(row: ReturnType<typeof credential>) {
  return {
    venueId: row.venue_id,
    venueName: row.venue_name,
    payload: { kind: 'venue_check_in', version: 1, venueId: row.venue_id, secret: row.secret },
  };
}

// SQL authorization and locking run in rls.test.ts. This fake checks the HTTP boundary and RPC
// arguments, including the actor supplied by authentication and conditional rotation.
const rpc = jest.fn<(name: string, params: Record<string, unknown>) => Promise<unknown>>();
const logs: unknown[] = [];
let credentials: ReturnType<typeof credential>[];
let reply: unknown;
let deleted: boolean;
let app: RunningApp;

beforeAll(async () => {
  app = await startApp(
    testDeps({
      logger: pino({ level: 'info' }, { write: (line: string) => logs.push(JSON.parse(line)) }),
      verifyToken: (token) => Promise.resolve(users.has(token) ? { id: token } : null),
      venueQrs: createVenueQrStore({ rpc } as unknown as Supabase),
    }),
  );
});
afterAll(async () => {
  if (app) await app.close();
});
beforeEach(() => {
  credentials = [credential()];
  reply = undefined;
  deleted = false;
  logs.length = 0;
  rpc.mockReset();
  rpc.mockImplementation((name, params) => {
    let data: unknown;
    const member = users.get(String(params.p_actor_id));
    if (params.p_event_id !== EVENT || deleted) data = { outcome: 'not_found' };
    else if (member?.status !== 'active') data = { outcome: 'not_member' };
    else if (member.role !== 'admin') data = { outcome: 'wrong_role' };
    else if (reply !== undefined) data = reply;
    else if (name === 'list_venue_qrs') data = { outcome: 'listed', venue_qrs: credentials };
    else {
      const current = credentials.find((qr) => qr.venue_id === params.p_venue_id);
      if (current === undefined) data = { outcome: 'not_found' };
      else if (current.secret !== params.p_expected_secret) data = { outcome: 'venue_qr_changed' };
      else {
        const next = credential(current.venue_id);
        credentials = credentials.map((qr) => (qr.venue_id === next.venue_id ? next : qr));
        data = { outcome: 'regenerated', venue_qr: next };
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
  venueId: string = VENUE,
) {
  const path = `/events/${eventId}/venue-qrs${method === 'POST' ? `/${venueId}/regenerate` : ''}`;
  return fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
const rotation = () => ({ expectedSecret: credentials[0]!.secret });
async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text();
  expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe(code);
  for (const qr of credentials) expect(text).not.toContain(qr.secret);
}

describe.each(['GET', 'POST'])('%s venue QR management', (method) => {
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
      expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_event_id: EVENT, p_actor_id: actor });
    },
  );
  it.each([null, 'expired-token'])('refuses session %s before the RPC', async (token) => {
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
  it('rejects a malformed event id before the RPC', async () => {
    await refused(
      await send(method, ADMIN, method === 'POST' ? rotation() : undefined, 'bad-id'),
      400,
      'invalid_request',
    );
    expect(rpc).not.toHaveBeenCalled();
  });
  it('reports a database failure without retrying or logging its credentials', async () => {
    const secret = credentials[0]!.secret;
    rpc.mockResolvedValue({ data: null, error: new Error(`RPC failed with ${secret}`) });
    await refused(
      await send(method, ADMIN, method === 'POST' ? rotation() : undefined),
      500,
      'internal_error',
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
});

it('lists one payload per venue with no-store and drops private database fields', async () => {
  credentials.push(credential(OTHER_VENUE));
  reply = {
    outcome: 'listed',
    venue_qrs: credentials.map((qr) => ({ ...qr, event_id: EVENT, private: 'omit' })),
  };
  const response = await send('GET');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(ListVenueQrsResponse.parse(await response.json())).toEqual({
    venueQrs: credentials.map(managed),
  });
  expect(rpc).toHaveBeenCalledWith('list_venue_qrs', { p_event_id: EVENT, p_actor_id: ADMIN });
});

it.each(['empty', 'duplicate', 'malformed', 'unknown'])(
  'refuses %s list data without returning credentials or repairing it',
  async (kind) => {
    const secret = credentials[0]!.secret;
    reply =
      kind === 'unknown'
        ? { outcome: secret }
        : {
            outcome: 'listed',
            venue_qrs:
              kind === 'empty'
                ? []
                : kind === 'duplicate'
                  ? [credentials[0], credentials[0]]
                  : [{ ...credentials[0], secret: 'bad' }],
          };
    await refused(await send('GET'), 500, 'internal_error');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs)).not.toContain(secret);
  },
);

it('regenerates only the named venue with the authenticated actor and displayed secret', async () => {
  credentials.push(credential(OTHER_VENUE));
  const before = structuredClone(credentials);
  const response = await send('POST', ADMIN, rotation());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(RegenerateVenueQrResponse.parse(await response.json())).toEqual({
    venueQr: managed(credentials[0]!),
  });
  expect(credentials[0]!.secret).not.toBe(before[0]!.secret);
  expect(credentials[1]).toEqual(before[1]);
  expect(rpc).toHaveBeenCalledWith('regenerate_venue_qr', {
    p_event_id: EVENT,
    p_actor_id: ADMIN,
    p_venue_id: VENUE,
    p_expected_secret: before[0]!.secret,
  });
});

it('refuses a venue outside the event without rotating', async () => {
  const before = structuredClone(credentials);
  await refused(await send('POST', ADMIN, rotation(), EVENT, OTHER_VENUE), 404, 'not_found');
  expect(credentials).toEqual(before);
});

it('returns 409 venue_qr_changed for a stale secret without another write or retry', async () => {
  const old = rotation();
  expect((await send('POST', ADMIN, old)).status).toBe(200);
  const after = structuredClone(credentials);
  await refused(await send('POST', ADMIN, old), 409, 'venue_qr_changed');
  expect(credentials).toEqual(after);
  expect(rpc).toHaveBeenCalledTimes(2);
});

it.each([
  undefined,
  {},
  { expectedSecret: 'bad' },
  { expectedSecret: 'AB'.repeat(32) },
  { expectedSecret: 'ab'.repeat(32), actorId: ADMIN },
  { expectedSecret: 'ab'.repeat(32), venueId: VENUE },
  '{',
])('rejects invalid rotation input %j before the RPC', async (body) => {
  await refused(await send('POST', ADMIN, body), 400, 'invalid_request');
  expect(rpc).not.toHaveBeenCalled();
});

it('rejects a malformed venue id before the RPC', async () => {
  await refused(await send('POST', ADMIN, rotation(), EVENT, 'bad-id'), 400, 'invalid_request');
  expect(rpc).not.toHaveBeenCalled();
});

it('refuses a replacement for another venue before returning its secret', async () => {
  reply = { outcome: 'regenerated', venue_qr: credential(OTHER_VENUE) };
  await refused(await send('POST', ADMIN, rotation()), 500, 'internal_error');
  expect(rpc).toHaveBeenCalledTimes(1);
});
