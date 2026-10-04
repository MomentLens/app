import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  ApproveRequestsResponse,
  BlockRequestResponse,
  ErrorResponse,
  ListPendingRequestsResponse,
  RejectRequestsResponse,
} from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import { accessVersion } from '../../src/services/attendees';
import type { JoinRequestStore, PendingRecord } from '../../src/services/join-requests';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const ADMIN = randomUUID();
const TARGET = randomUUID();
const SECOND = randomUUID();
const ROW = randomUUID();
const version = (counter: string, id: string = ROW) => accessVersion(id, counter);
// A token accessVersion would refuse to build, as a tampered app could send it.
const rawVersion = (counter: string) =>
  Buffer.from(JSON.stringify({ id: ROW, version: counter })).toString('base64url');
const members = new Map<string, { role: MembershipRole; status: MembershipStatus }>();
const actors = [
  'admin',
  'other-admin',
  'guest',
  'photographer',
  'pending',
  'removed',
  'blocked',
  'outsider',
];
const ids = new Map(actors.map((actor) => [actor, actor === 'admin' ? ADMIN : randomUUID()]));
const list = jest.fn<JoinRequestStore['list']>();
const act = jest.fn<JoinRequestStore['act']>();
let deleted = false;
const presignGet = jest.fn(() => Promise.resolve('https://example.com/private'));
const findProfile = jest.fn(() => Promise.resolve(null));
let running: RunningApp;

function pending(index: number, userId = randomUUID()): PendingRecord {
  return {
    id: randomUUID(),
    userId,
    fullName: `Requester ${index.toString().padStart(2, '0')}`,
    role: 'guest',
    // Microseconds, as Postgres stores them, so a cursor that kept only milliseconds would skip a
    // request made in the same millisecond.
    requestedAt: `2026-10-04T10:00:00.${index.toString().padStart(6, '0')}Z`,
    version: '1',
  };
}

beforeAll(async () => {
  const deps = testDeps();
  running = await startApp(
    testDeps({
      verifyToken: (token) => Promise.resolve(ids.has(token) ? { id: ids.get(token)! } : null),
      events: {
        ...deps.events,
        findAccess: (eventId, userId) =>
          Promise.resolve(
            eventId === EVENT
              ? { deleted, albumOpen: false, membership: members.get(userId) ?? null }
              : null,
          ),
      },
      joinRequests: { list, act },
      presignGet,
      findProfile,
    }),
  );
});
afterAll(async () => running.close());
beforeEach(() => {
  jest.clearAllMocks();
  deleted = false;
  list.mockReset().mockResolvedValue({
    outcome: 'listed',
    activeGuests: 12,
    rows: [
      {
        id: ROW,
        userId: TARGET,
        fullName: 'Ayesha Khan',
        role: 'photographer',
        requestedAt: '2026-10-04T10:00:00.123456Z',
        version: '1',
      },
    ],
  });
  act.mockReset().mockImplementation((_event, _actor, action, targets) =>
    Promise.resolve({
      outcome: 'updated',
      memberships: targets.map((target) => ({
        userId: target.userId,
        role: 'guest',
        status: action === 'approve' ? 'active' : action === 'reject' ? 'removed' : 'blocked',
        accessVersion: version('2', target.expected.id),
      })),
    }),
  );
  members.clear();
  members.set(ADMIN, { role: 'admin', status: 'active' });
  for (const actor of ['guest', 'photographer'] as const)
    members.set(ids.get(actor)!, { role: actor, status: 'active' });
  for (const actor of ['pending', 'removed', 'blocked'] as const)
    members.set(ids.get(actor)!, { role: 'guest', status: actor });
});

const target = { userId: TARGET, expectedVersion: version('1') };
const actions = [
  { name: 'list', method: 'GET', suffix: '', body: undefined },
  { name: 'approve', method: 'POST', suffix: '/approve', body: { targets: [target] } },
  { name: 'reject', method: 'POST', suffix: '/reject', body: { targets: [target] } },
  {
    name: 'block',
    method: 'POST',
    suffix: `/${TARGET}/block`,
    body: { expectedVersion: version('1') },
  },
] as const;
const [listing, approve, reject, block] = actions;
const writes = [approve, reject, block];
const batches = [approve, reject];

function send(
  action: (typeof actions)[number],
  actor?: string,
  eventId = EVENT,
  body: unknown = action.body,
  suffix: string = action.suffix,
) {
  return fetch(`${running.baseUrl}/events/${eventId}/join-requests${suffix}`, {
    method: action.method,
    headers: {
      ...(actor ? { Authorization: `Bearer ${actor}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function refusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(ErrorResponse.parse(await response.json()).error.code).toBe(code);
}
function untouched() {
  expect(list).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
}

describe.each(actions)('$name join requests authorization', (action) => {
  it.each([undefined, 'expired'])('denies session %s before reading or writing', async (actor) => {
    await refusal(await send(action, actor), 401, 'no_session');
    untouched();
  });
  it.each(['other-admin', 'pending', 'removed', 'blocked', 'outsider'])(
    'denies %s',
    async (actor) => {
      await refusal(await send(action, actor), 403, 'not_member');
      untouched();
    },
  );
  it.each(['guest', 'photographer'])('denies the wrong role %s', async (actor) => {
    await refusal(await send(action, actor), 403, 'wrong_role');
    untouched();
  });
  it('denies another event', async () => {
    await refusal(await send(action, 'admin', OTHER_EVENT), 404, 'not_found');
    untouched();
  });
  it('refuses a deleted event before calling an RPC', async () => {
    deleted = true;
    await refusal(await send(action, 'admin'), 404, 'not_found');
    untouched();
  });
});

it('lists pending requests with null avatars, the places left, and no avatar read', async () => {
  const response = await send(listing, 'admin');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(ListPendingRequestsResponse.parse(await response.json())).toEqual({
    requests: [
      {
        userId: TARGET,
        fullName: 'Ayesha Khan',
        role: 'photographer',
        requestedAt: '2026-10-04T10:00:00.123Z',
        accessVersion: version('1'),
        avatar: null,
      },
    ],
    nextCursor: null,
    guestPlacesLeft: 138,
  });
  expect(list).toHaveBeenCalledWith(EVENT, ADMIN, null);
  expect(presignGet).not.toHaveBeenCalled();
  expect(findProfile).not.toHaveBeenCalled();
});

it.each([
  [150, 0],
  [151, 0],
  [0, 150],
])('answers %i active Guests with %i places left', async (activeGuests, left) => {
  list.mockResolvedValueOnce({ outcome: 'listed', activeGuests, rows: [] });
  const body = ListPendingRequestsResponse.parse(await (await send(listing, 'admin')).json());
  expect(body).toEqual({ requests: [], nextCursor: null, guestPlacesLeft: left });
});

it('pages by request time to the microsecond, then user id, with a cursor bound to the event', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => pending(index));
  list.mockResolvedValueOnce({ outcome: 'listed', activeGuests: 0, rows });
  const headers = { Authorization: 'Bearer admin' };
  const url = `${running.baseUrl}/events/${EVENT}/join-requests`;
  const first = ListPendingRequestsResponse.parse(await (await fetch(url, { headers })).json());
  expect(first.requests).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  list.mockResolvedValueOnce({ outcome: 'listed', activeGuests: 0, rows: rows.slice(50) });
  const second = ListPendingRequestsResponse.parse(
    await (await fetch(`${url}?cursor=${first.nextCursor}`, { headers })).json(),
  );
  expect(second.requests).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(list).toHaveBeenLastCalledWith(EVENT, ADMIN, {
    requestedAt: rows[49]!.requestedAt,
    userId: rows[49]!.userId,
  });
  await refusal(
    await fetch(
      `${running.baseUrl}/events/${OTHER_EVENT}/join-requests?cursor=${first.nextCursor}`,
      { headers },
    ),
    400,
    'invalid_request',
  );
  list.mockResolvedValueOnce({ outcome: 'listed', activeGuests: 0, rows: rows.slice(0, 50) });
  expect(
    ListPendingRequestsResponse.parse(await (await fetch(url, { headers })).json()).nextCursor,
  ).toBeNull();
});

const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
it.each([
  '?cursor=garbage',
  '?cursor=a&cursor=b',
  '?status=active',
  `?cursor=${cursor({ eventId: EVENT, requestedAt: '2026-02-30T10:00:00.000000Z', userId: TARGET })}`,
  `?cursor=${cursor({ eventId: EVENT, requestedAt: '2026-10-04T10:00:00.123Z', userId: TARGET })}`,
  `?cursor=${cursor({ eventId: EVENT, requestedAt: '1969-12-31T23:59:59.000000Z', userId: TARGET })}`,
  `?cursor=${cursor({ eventId: EVENT, requestedAt: '2026-10-04T10:00:00.000000Z', userId: 'x' })}`,
])('rejects query %s before the store', async (query) => {
  const response = await fetch(`${running.baseUrl}/events/${EVENT}/join-requests${query}`, {
    headers: { Authorization: 'Bearer admin' },
  });
  await refusal(response, 400, 'invalid_request');
  expect(list).not.toHaveBeenCalled();
});

describe.each(batches)('$name batch validation', (action) => {
  const many = (count: number) =>
    Array.from({ length: count }, () => ({
      userId: randomUUID(),
      expectedVersion: version('1', randomUUID()),
    }));
  it.each([
    ['no targets', { targets: [] }],
    ['51 targets', { targets: many(51) }],
    ['a repeated person', { targets: [target, target] }],
    [
      'a repeated person in upper case',
      { targets: [target, { ...target, userId: TARGET.toUpperCase() }] },
    ],
    ['a garbage version', { targets: [{ ...target, expectedVersion: 'garbage' }] }],
    ['a zero counter', { targets: [{ ...target, expectedVersion: rawVersion('0') }] }],
    ['a non-uuid person', { targets: [{ ...target, userId: 'someone' }] }],
    ['an extra target field', { targets: [{ ...target, role: 'admin' }] }],
    ['an extra body field', { targets: [target], approveAll: true }],
    ['no body', undefined],
  ])('rejects %s before the store', async (_label, body) => {
    await refusal(await send(action, 'admin', EVENT, body ?? null), 400, 'invalid_request');
    expect(act).not.toHaveBeenCalled();
  });
  it('accepts 50 targets and passes each decoded version once', async () => {
    const targets = many(50);
    const response = await send(action, 'admin', EVENT, { targets });
    expect(response.status).toBe(200);
    expect(act).toHaveBeenCalledTimes(1);
    expect(act.mock.calls[0]![3]).toHaveLength(50);
  });
});

it.each([
  ['a person in the body', { expectedVersion: version('1'), userId: SECOND }],
  ['a batch', { targets: [target] }],
  ['a garbage version', { expectedVersion: 'garbage' }],
  ['no version', {}],
])('rejects a block with %s before the store', async (_label, body) => {
  await refusal(await send(block, 'admin', EVENT, body), 400, 'invalid_request');
  expect(act).not.toHaveBeenCalled();
});

it('rejects a block whose path names no uuid', async () => {
  await refusal(
    await send(block, 'admin', EVENT, block.body, '/someone/block'),
    400,
    'invalid_request',
  );
  expect(act).not.toHaveBeenCalled();
});

describe.each(writes)('$name outcomes', (action) => {
  it.each([
    ['not_found', 404],
    ['not_member', 403],
    ['wrong_role', 403],
    ['invalid_request', 400],
    ['membership_changed', 409],
    ['event_full', 422],
  ] as const)('maps a transactional %s refusal and does not retry', async (outcome, status) => {
    act.mockResolvedValueOnce({ outcome });
    await refusal(await send(action, 'admin'), status, outcome);
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith(
      EVENT,
      ADMIN,
      action.name,
      [{ userId: TARGET, expected: { id: ROW, version: '1' } }],
      150,
    );
  });
});

it('approves a batch and returns each active membership without a profile', async () => {
  const targets = [target, { userId: SECOND.toUpperCase(), expectedVersion: version('7', SECOND) }];
  const response = await send(approve, 'admin', EVENT, { targets });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(ApproveRequestsResponse.parse(await response.json())).toEqual({
    memberships: [
      { userId: TARGET, role: 'guest', status: 'active', accessVersion: version('2') },
      { userId: SECOND, role: 'guest', status: 'active', accessVersion: version('2', SECOND) },
    ],
  });
  expect(act).toHaveBeenCalledWith(
    EVENT,
    ADMIN,
    'approve',
    [
      { userId: TARGET, expected: { id: ROW, version: '1' } },
      { userId: SECOND, expected: { id: SECOND, version: '7' } },
    ],
    150,
  );
  expect(presignGet).not.toHaveBeenCalled();
});

it('rejects a batch into removed memberships', async () => {
  const response = await send(reject, 'admin');
  expect(response.status).toBe(200);
  expect(RejectRequestsResponse.parse(await response.json())).toEqual({
    memberships: [
      { userId: TARGET, role: 'guest', status: 'removed', accessVersion: version('2') },
    ],
  });
});

it('blocks one request named by the path', async () => {
  const response = await send(block, 'admin');
  expect(response.status).toBe(200);
  expect(BlockRequestResponse.parse(await response.json())).toEqual({
    membership: { userId: TARGET, role: 'guest', status: 'blocked', accessVersion: version('2') },
  });
});

it.each([
  ['a pending status from an approve', 1, 'pending'],
  ['an Admin row from a reject', 2, 'removed'],
] as const)('refuses to send %s', async (_label, index, status) => {
  act.mockResolvedValueOnce({
    outcome: 'updated',
    memberships: [
      {
        userId: TARGET,
        role: index === 2 ? 'admin' : 'guest',
        status,
        accessVersion: version('2'),
      },
    ],
  });
  await refusal(await send(actions[index], 'admin'), 500, 'internal_error');
});

it('reports an RPC outage as internal_error', async () => {
  list.mockRejectedValueOnce(new Error('database unavailable'));
  await refusal(await send(listing, 'admin'), 500, 'internal_error');
  act.mockRejectedValueOnce(new Error('database unavailable'));
  await refusal(await send(approve, 'admin'), 500, 'internal_error');
});
