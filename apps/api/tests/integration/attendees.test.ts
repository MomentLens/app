import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  ErrorResponse,
  ForceVerifyAttendeeResponse,
  ListAttendeesResponse,
} from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import { accessVersion } from '../../src/services/attendees';
import type { AttendeeStore } from '../../src/services/attendees';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const ADMIN = randomUUID();
const TARGET = randomUUID();
const ROW = randomUUID();
const version = (counter: string) =>
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
const list = jest.fn<AttendeeStore['list']>();
const mutate = jest.fn<AttendeeStore['mutate']>();
const forceVerify = jest.fn<AttendeeStore['forceVerify']>();
let deleted = false;
const presignGet = jest.fn(() => Promise.resolve('https://example.com/private'));
let running: RunningApp;

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
      attendees: { list, mutate, forceVerify },
      presignGet,
    }),
  );
});
afterAll(async () => running.close());
beforeEach(() => {
  jest.clearAllMocks();
  deleted = false;
  list.mockReset().mockResolvedValue({
    outcome: 'listed',
    rows: [
      {
        id: ROW,
        userId: TARGET,
        fullName: 'Ayesha Khan',
        role: 'guest',
        requestedAt: '2026-10-04T10:00:00.000Z',
        version: '1',
        verification: { everySubEvent: false, subEventIds: [] },
      },
    ],
  });
  mutate.mockReset().mockImplementation((_event, _actor, userId, action, _expected, role) =>
    Promise.resolve({
      outcome: 'updated',
      membership: {
        userId,
        role: role ?? 'guest',
        status: action === 'role' ? 'active' : action === 'remove' ? 'removed' : 'blocked',
        accessVersion: version('2'),
      },
    }),
  );
  members.clear();
  forceVerify.mockReset().mockResolvedValue({
    outcome: 'verified',
    membership: {
      userId: TARGET,
      role: 'guest',
      status: 'active',
      accessVersion: version('1'),
    },
    adminVerifiedAt: '2026-10-12T10:00:00.000Z',
  });
  members.set(ADMIN, { role: 'admin', status: 'active' });
  for (const actor of ['guest', 'photographer'] as const)
    members.set(ids.get(actor)!, { role: actor, status: 'active' });
  for (const actor of ['pending', 'removed', 'blocked'] as const)
    members.set(ids.get(actor)!, { role: 'guest', status: actor });
});

const actions = [
  { method: 'GET', suffix: '', body: undefined },
  {
    method: 'PATCH',
    suffix: `/${TARGET}/role`,
    body: { expectedVersion: version('1'), role: 'photographer' },
  },
  { method: 'POST', suffix: `/${TARGET}/remove`, body: { expectedVersion: version('1') } },
  { method: 'POST', suffix: `/${TARGET}/block`, body: { expectedVersion: version('1') } },
];
function send(
  action: (typeof actions)[number],
  actor?: string,
  eventId = EVENT,
  body: unknown = action.body,
) {
  return fetch(`${running.baseUrl}/events/${eventId}/attendees${action.suffix}`, {
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

describe.each(actions)('$method attendees$suffix authorization', (action) => {
  it.each([undefined, 'expired'])('denies session %s before reading or writing', async (actor) => {
    await refusal(await send(action, actor), 401, 'no_session');
    expect(list).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each(['other-admin', 'pending', 'removed', 'blocked', 'outsider'])(
    'denies %s',
    async (actor) => {
      await refusal(await send(action, actor), 403, 'not_member');
      expect(list).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it.each(['guest', 'photographer'])('denies the wrong role %s', async (actor) => {
    await refusal(await send(action, actor), 403, 'wrong_role');
    expect(list).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
  it('denies another event', async () => {
    await refusal(await send(action, 'admin', OTHER_EVENT), 404, 'not_found');
  });
});

it('returns active attendees with null avatars and no presigning', async () => {
  const response = await send(actions[0]!, 'admin');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(ListAttendeesResponse.parse(await response.json())).toEqual({
    attendees: [
      {
        userId: TARGET,
        fullName: 'Ayesha Khan',
        role: 'guest',
        requestedAt: '2026-10-04T10:00:00.000Z',
        accessVersion: version('1'),
        avatar: null,
        verification: { everySubEvent: false, subEventIds: [] },
      },
    ],
    nextCursor: null,
  });
  expect(presignGet).not.toHaveBeenCalled();
});

it.each([
  '?role=admin&role=guest',
  '?userId=someone',
  '?cursor=garbage',
  '?role=owner',
  '?checkIn=checked_in',
  '?subEventId=garbage',
  `?subEventId=${randomUUID()}&checkIn=unknown`,
  `?search=${'a'.repeat(81)}`,
])('rejects query %s', async (query) => {
  const response = await fetch(`${running.baseUrl}/events/${EVENT}/attendees${query}`, {
    headers: { Authorization: 'Bearer admin' },
  });
  await refusal(response, 400, 'invalid_request');
  expect(list).not.toHaveBeenCalled();
});

it.each(actions.slice(1))(
  'rejects target injection and Admin promotion on $suffix',
  async (action) => {
    await refusal(
      await send(action, 'admin', EVENT, { ...action.body, userId: TARGET }),
      400,
      'invalid_request',
    );
    await refusal(
      await send(action, 'admin', EVENT, { ...action.body, expectedVersion: 'garbage' }),
      400,
      'invalid_request',
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);

it('rejects promotion to Admin before the store', async () => {
  await refusal(
    await send(actions[1]!, 'admin', EVENT, { expectedVersion: version('1'), role: 'admin' }),
    400,
    'invalid_request',
  );
  expect(mutate).not.toHaveBeenCalled();
});

describe.each(actions)('$method attendees$suffix lifecycle', (action) => {
  it('refuses a deleted event before calling an RPC', async () => {
    deleted = true;
    await refusal(await send(action, 'admin'), 404, 'not_found');
    expect(list).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe.each(actions.slice(1))('$method attendees$suffix outcomes', (action) => {
  it.each([
    ['not_found', 404],
    ['not_member', 403],
    ['wrong_role', 403],
    ['invalid_request', 400],
    ['membership_changed', 409],
    ['event_full', 422],
  ] as const)('maps transactional %s refusals and performs no retry', async (outcome, status) => {
    mutate.mockResolvedValueOnce({ outcome });
    await refusal(await send(action, 'admin'), status, outcome);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      EVENT,
      ADMIN,
      TARGET,
      action.suffix.endsWith('role')
        ? 'role'
        : action.suffix.endsWith('remove')
          ? 'remove'
          : 'block',
      { id: ROW, version: '1' },
      action.suffix.endsWith('role') ? 'photographer' : null,
      150,
    );
  });
  it('returns the resulting membership without a profile or presigning', async () => {
    const response = await send(action, 'admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      membership: {
        userId: TARGET,
        role: action.suffix.endsWith('role') ? 'photographer' : 'guest',
        status: action.suffix.endsWith('role')
          ? 'active'
          : action.suffix.endsWith('remove')
            ? 'removed'
            : 'blocked',
        accessVersion: version('2'),
      },
    });
    expect(presignGet).not.toHaveBeenCalled();
  });
});

it('returns an empty page and handles a transactional actor recheck', async () => {
  list.mockResolvedValueOnce({ outcome: 'listed', rows: [] });
  const response = await send(actions[0]!, 'admin');
  expect(await response.json()).toEqual({ attendees: [], nextCursor: null });
  list.mockResolvedValueOnce({ outcome: 'not_member' });
  await refusal(await send(actions[0]!, 'admin'), 403, 'not_member');
});

it('passes trimmed literal search and uses a cursor bound to the event and filters', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({
    id: randomUUID(),
    userId: randomUUID(),
    fullName: `Name ${index.toString().padStart(2, '0')}`,
    role: 'photographer' as const,
    requestedAt: '2026-10-04T10:00:00.000Z',
    version: '1',
    verification: { everySubEvent: true, subEventIds: [] },
  }));
  list.mockResolvedValueOnce({ outcome: 'listed', rows });
  const headers = { Authorization: 'Bearer admin' };
  const url = `${running.baseUrl}/events/${EVENT}/attendees?search=${encodeURIComponent(' _%\\ ')}&role=photographer`;
  const first = ListAttendeesResponse.parse(await (await fetch(url, { headers })).json());
  expect(first.attendees).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  expect(list).toHaveBeenLastCalledWith(EVENT, ADMIN, {
    search: '_%\\',
    role: 'photographer',
    subEventId: null,
    checkIn: null,
    after: null,
  });
  list.mockResolvedValueOnce({ outcome: 'listed', rows: rows.slice(50) });
  const second = ListAttendeesResponse.parse(
    await (await fetch(`${url}&cursor=${first.nextCursor}`, { headers })).json(),
  );
  expect(second.attendees).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(list).toHaveBeenLastCalledWith(EVENT, ADMIN, {
    search: '_%\\',
    role: 'photographer',
    subEventId: null,
    checkIn: null,
    after: { name: rows[49]!.fullName, userId: rows[49]!.userId },
  });
  for (const changed of [
    `${running.baseUrl}/events/${EVENT}/attendees`,
    `${running.baseUrl}/events/${OTHER_EVENT}/attendees`,
  ]) {
    await refusal(
      await fetch(`${changed}?cursor=${first.nextCursor}`, { headers }),
      400,
      'invalid_request',
    );
  }
  list.mockResolvedValueOnce({ outcome: 'listed', rows: rows.slice(0, 50) });
  expect(
    ListAttendeesResponse.parse(await (await fetch(url, { headers })).json()).nextCursor,
  ).toBeNull();
});

it.each(['0', '-1', '01', '9223372036854775808'])(
  'rejects invalid access counter %s before the RPC',
  async (counter) => {
    await refusal(
      await send(actions[2]!, 'admin', EVENT, { expectedVersion: version(counter) }),
      400,
      'invalid_request',
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);

it('keeps access counters beyond JavaScript integer precision unchanged', async () => {
  const counter = '9007199254740993';
  const expectedVersion = accessVersion(ROW, counter);
  const response = await send(actions[2]!, 'admin', EVENT, { expectedVersion });
  expect(response.status).toBe(200);
  expect(mutate.mock.calls[0]![4]).toEqual({ id: ROW, version: counter });
});

it('reports an RPC outage as internal_error', async () => {
  list.mockRejectedValueOnce(new Error('database unavailable'));
  await refusal(await send(actions[0]!, 'admin'), 500, 'internal_error');
});

const manual = {
  method: 'POST',
  suffix: `/${TARGET}/force-verify`,
  body: { expectedVersion: version('1') },
};

describe('S-17 manual check-in', () => {
  it.each([
    [undefined, 401, 'no_session'],
    ['expired', 401, 'no_session'],
    ['other-admin', 403, 'not_member'],
    ['outsider', 403, 'not_member'],
    ['pending', 403, 'not_member'],
    ['removed', 403, 'not_member'],
    ['blocked', 403, 'not_member'],
    ['guest', 403, 'wrong_role'],
    ['photographer', 403, 'wrong_role'],
  ] as const)('refuses actor %s before the grant', async (actor, status, code) => {
    await refusal(await send(manual, actor), status, code);
    expect(forceVerify).not.toHaveBeenCalled();
  });

  it('refuses another event and a deleted event before the grant', async () => {
    await refusal(await send(manual, 'admin', OTHER_EVENT), 404, 'not_found');
    deleted = true;
    await refusal(await send(manual, 'admin'), 404, 'not_found');
    expect(forceVerify).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { expectedVersion: 'garbage' },
    { expectedVersion: version('0') },
    { expectedVersion: version('9223372036854775808') },
    { expectedVersion: version('1'), userId: TARGET },
    { expectedVersion: version('1'), eventId: EVENT },
    { expectedVersion: version('1'), actorId: ADMIN },
    { expectedVersion: version('1'), verified: true },
    { expectedVersion: version('1'), role: 'guest' },
    { expectedVersion: version('1'), adminVerifiedAt: '2026-10-12T00:00:00.000Z' },
  ])('refuses injected or invalid grant body %j', async (body) => {
    await refusal(await send(manual, 'admin', EVENT, body), 400, 'invalid_request');
    expect(forceVerify).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['invalid_request', 400],
    ['membership_changed', 409],
    ['not_member', 403],
    ['wrong_role', 403],
  ] as const)('maps target or actor recheck %s without retrying', async (outcome, status) => {
    forceVerify.mockResolvedValueOnce({ outcome });
    await refusal(await send(manual, 'admin'), status, outcome);
    expect(forceVerify).toHaveBeenCalledTimes(1);
    expect(forceVerify).toHaveBeenCalledWith(EVENT, ADMIN, TARGET, { id: ROW, version: '1' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('returns the first server timestamp and unchanged version on explicit repeats', async () => {
    const first = await send(manual, 'admin');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const value = ForceVerifyAttendeeResponse.parse(await first.json());
    expect(value).toEqual({
      membership: { userId: TARGET, role: 'guest', status: 'active', accessVersion: version('1') },
      adminVerifiedAt: '2026-10-12T10:00:00.000Z',
    });
    const repeat = await send(manual, 'admin');
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(value);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it('accepts an active Photographer and preserves bigint version precision', async () => {
    const expectedVersion = version('9007199254740993');
    forceVerify.mockResolvedValueOnce({
      outcome: 'verified',
      membership: {
        userId: TARGET,
        role: 'photographer',
        status: 'active',
        accessVersion: expectedVersion,
      },
      adminVerifiedAt: '2026-10-12T10:00:00.000Z',
    });
    const response = await send(manual, 'admin', EVENT, { expectedVersion });
    expect(response.status).toBe(200);
    expect(ForceVerifyAttendeeResponse.parse(await response.json()).membership.role).toBe(
      'photographer',
    );
    expect(forceVerify.mock.calls[0]![3]).toEqual({ id: ROW, version: '9007199254740993' });
  });

  it('does not retry an uncertain RPC failure', async () => {
    forceVerify.mockRejectedValueOnce(new Error('response lost'));
    await refusal(await send(manual, 'admin'), 500, 'internal_error');
    expect(forceVerify).toHaveBeenCalledTimes(1);
  });
});

describe('S-17 attendee coverage and pagination', () => {
  const subEventId = randomUUID();
  const headers = { Authorization: 'Bearer admin' };
  const url = () => `${running.baseUrl}/events/${EVENT}/attendees`;
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      userId: randomUUID(),
      fullName: `Name ${index.toString().padStart(2, '0')}`,
      role: 'guest' as const,
      requestedAt: '2026-10-12T10:00:00.000Z',
      version: '1',
      verification: { everySubEvent: false, subEventIds: [subEventId] },
    }));

  it.each([0, 1, 50, 51])('returns a bounded page from %i rows', async (count) => {
    list.mockResolvedValueOnce({ outcome: 'listed', rows: rows(count) });
    const response = await fetch(url(), { headers });
    expect(response.status).toBe(200);
    const result = ListAttendeesResponse.parse(await response.json());
    expect(result.attendees).toHaveLength(Math.min(count, 50));
    expect(result.nextCursor !== null).toBe(count === 51);
  });

  it('passes the selected sub-event and check-in filter and binds both to the cursor', async () => {
    const query = { search: 'Name', role: 'guest', subEventId, checkIn: 'checked_in' } as const;
    const pageRows = rows(51);
    list.mockResolvedValueOnce({ outcome: 'listed', rows: pageRows });
    const first = ListAttendeesResponse.parse(
      await (await fetch(`${url()}?${new URLSearchParams(query).toString()}`, { headers })).json(),
    );
    expect(list).toHaveBeenLastCalledWith(EVENT, ADMIN, {
      ...query,
      after: null,
    });
    expect(first.nextCursor).not.toBeNull();
    for (const changed of [
      { ...query, search: 'Other' },
      { ...query, role: 'photographer' },
      { ...query, subEventId: randomUUID() },
      { ...query, checkIn: 'not_checked_in' },
      { search: query.search, role: query.role },
    ]) {
      await refusal(
        await fetch(
          `${url()}?${new URLSearchParams({ ...changed, cursor: first.nextCursor! }).toString()}`,
          {
            headers,
          },
        ),
        400,
        'invalid_request',
      );
    }
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValueOnce({ outcome: 'listed', rows: pageRows.slice(50) });
    const second = await fetch(
      `${url()}?${new URLSearchParams({ ...query, cursor: first.nextCursor! }).toString()}`,
      { headers },
    );
    expect(second.status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(EVENT, ADMIN, {
      ...query,
      after: { name: pageRows[49]!.fullName, userId: pageRows[49]!.userId },
    });
  });

  it('maps an unknown, deleted or other-event sub-event to not_found', async () => {
    list.mockResolvedValueOnce({ outcome: 'not_found' });
    await refusal(await fetch(`${url()}?subEventId=${subEventId}`, { headers }), 404, 'not_found');
  });

  it('returns only server coverage and omits private avatar and evidence fields', async () => {
    const record = {
      ...rows(1)[0]!,
      avatarKey: 'private-avatar',
      secret: 'private-qr-secret',
      lat: 31.55,
      lng: 74.35,
      embedding: [1, 2],
      verification: { everySubEvent: true, subEventIds: [subEventId] },
    };
    list.mockResolvedValueOnce({ outcome: 'listed', rows: [record] });
    const response = await fetch(url(), { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { attendees: unknown[] };
    expect(body.attendees[0]).toEqual({
      userId: record.userId,
      fullName: record.fullName,
      role: record.role,
      requestedAt: record.requestedAt,
      accessVersion: accessVersion(record.id, record.version),
      avatar: null,
      verification: record.verification,
    });
    expect(presignGet).not.toHaveBeenCalled();
  });
});
