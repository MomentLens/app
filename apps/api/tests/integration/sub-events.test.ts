// GET /events/{eventId}/sub-events, POST /events/{eventId}/sub-events, PATCH /sub-events/{subEventId}
// and DELETE /sub-events/{subEventId} (D-121). Both stores are in-memory fakes. The sub-event store
// writes for any caller and reads a deleted event's schedule, where the real functions behind it
// take no user and refuse a deleted event, so each refusal below is the service's own check holding,
// not the store's. rls.test.ts runs the real store and its four functions against the dev project.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { ErrorResponse, ListSubEventsResponse } from '@momentlens/shared-types';
import type {
  AddSubEventRequest,
  MembershipRole,
  MembershipStatus,
  SubEvent,
  UpdateSubEventRequest,
} from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import type {
  AddResult,
  DeleteResult,
  SubEventStore,
  UpdateResult,
} from '../../src/services/sub-events';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const ADMIN = randomUUID();
// The Admin of another event, and nothing in this one.
const OTHER_ADMIN = randomUUID();
const GUEST = randomUUID();
const PHOTOGRAPHER = randomUUID();
const PENDING = randomUUID();
const BLOCKED = randomUUID();
const REMOVED = randomUUID();
const OUTSIDER = randomUUID();

const tokens = new Map([
  ['token-admin', ADMIN],
  ['token-other-admin', OTHER_ADMIN],
  ['token-guest', GUEST],
  ['token-photographer', PHOTOGRAPHER],
  ['token-pending', PENDING],
  ['token-blocked', BLOCKED],
  ['token-removed', REMOVED],
  ['token-outsider', OUTSIDER],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

// Every caller who is not an active member of the seeded event, and who therefore gets 403
// not_member from every endpoint here.
const NOT_MEMBERS = [
  ['a pending member', 'token-pending'],
  ['a blocked member', 'token-blocked'],
  ['a removed member', 'token-removed'],
  ['someone with no membership', 'token-outsider'],
  ["another event's Admin", 'token-other-admin'],
] as const;

const NOT_ADMINS = [
  ['a Guest', 'token-guest'],
  ['a Photographer', 'token-photographer'],
] as const;

interface FakeEvent {
  deleted: boolean;
  members: Map<string, { role: MembershipRole; status: MembershipStatus }>;
}

// Answers only findAccess, which is all the sub-event endpoints read from the event store.
class FakeEvents implements EventStore {
  readonly events = new Map<string, FakeEvent>();

  create = () => Promise.reject(new Error('not used here'));
  listForMember = () => Promise.reject(new Error('not used here'));
  listJoinRequests = () => Promise.reject(new Error('not used here'));
  findForCaller = () => Promise.reject(new Error('not used here'));
  setCover = () => Promise.reject(new Error('not used here'));
  settings = () => Promise.reject(new Error('not used here'));
  updateSettings = () => Promise.reject(new Error('not used here'));

  findAccess(eventId: string, userId: string): Promise<MemberAccess | null> {
    const event = this.events.get(eventId);
    if (event === undefined) return Promise.resolve(null);
    return Promise.resolve({
      deleted: event.deleted,
      albumOpen: false,
      membership: event.members.get(userId) ?? null,
    });
  }
}

type Write =
  | { kind: 'add'; eventId: string; request: AddSubEventRequest }
  | { kind: 'update'; eventId: string; subEventId: string; request: UpdateSubEventRequest }
  | { kind: 'remove'; eventId: string; subEventId: string };

// Holds each event's schedule and records every write. A write applies itself unless `answer` holds
// an outcome for the store to give instead, as the real functions give a refusal.
class FakeSubEvents implements SubEventStore {
  readonly schedules = new Map<string, SubEvent[]>();
  readonly writes: Write[] = [];
  answer: { outcome: string } | null = null;
  // As the real schedule read answers for an event soft-deleted after the service's check.
  scheduleGone = false;
  failWith: Error | null = null;

  findEventId(subEventId: string): Promise<string | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    for (const [eventId, schedule] of this.schedules) {
      if (schedule.some((s) => s.id === subEventId)) return Promise.resolve(eventId);
    }
    return Promise.resolve(null);
  }

  schedule(eventId: string): Promise<SubEvent[] | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.scheduleGone) return Promise.resolve(null);
    return Promise.resolve(this.schedules.get(eventId) ?? null);
  }

  add(eventId: string, request: AddSubEventRequest): Promise<AddResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.writes.push({ kind: 'add', eventId, request });
    if (this.answer) return Promise.resolve(this.answer as AddResult);
    const schedule = this.schedules.get(eventId) ?? [];
    schedule.push(
      withSecret({
        id: randomUUID(),
        name: request.name,
        // As the function stores it: an empty description is null.
        description: request.description === '' ? null : (request.description ?? null),
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        verificationRadiusM: request.verificationRadiusM,
        venue:
          'id' in request.venue
            ? { id: request.venue.id, name: 'Venue', lat: 31.5, lng: 74.3 }
            : { id: randomUUID(), ...request.venue },
      }),
    );
    this.schedules.set(eventId, schedule);
    return Promise.resolve({ outcome: 'added', subEvents: schedule });
  }

  update(
    eventId: string,
    subEventId: string,
    request: UpdateSubEventRequest,
  ): Promise<UpdateResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.writes.push({ kind: 'update', eventId, subEventId, request });
    if (this.answer) return Promise.resolve(this.answer as UpdateResult);
    const schedule = this.schedules.get(eventId) ?? [];
    const subEvent = schedule.find((s) => s.id === subEventId);
    if (subEvent === undefined) return Promise.resolve({ outcome: 'not_found' });
    if (request.name !== undefined) subEvent.name = request.name;
    return Promise.resolve({ outcome: 'updated', subEvents: schedule });
  }

  remove(eventId: string, subEventId: string): Promise<DeleteResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.writes.push({ kind: 'remove', eventId, subEventId });
    if (this.answer) return Promise.resolve(this.answer as DeleteResult);
    const schedule = (this.schedules.get(eventId) ?? []).filter((s) => s.id !== subEventId);
    this.schedules.set(eventId, schedule);
    return Promise.resolve({ outcome: 'deleted', subEvents: schedule });
  }
}

// A sub-event carrying its venue's qr_secret, which the real row has and no response may carry.
// Cast: the real store's row parse drops every key the contract does not name.
function withSecret(subEvent: SubEvent): SubEvent {
  return {
    ...subEvent,
    venue: { ...subEvent.venue, qr_secret: 'c2VjcmV0LXNob3VsZC1uZXZlci1sZWF2ZQ' },
  } as SubEvent;
}

const HALL = randomUUID();
const HOME = randomUUID();

// Mehndi at the family home, then the baraat at the hall, as GET returns them.
function seedSchedule(): SubEvent[] {
  return [
    withSecret({
      id: randomUUID(),
      name: 'Mehndi',
      description: 'Yellow dress code',
      startsAt: '2026-12-10T14:00:00.000Z',
      endsAt: '2026-12-10T18:00:00.000Z',
      verificationRadiusM: 300,
      venue: { id: HOME, name: 'Family Home', lat: 31.52, lng: 74.35 },
    }),
    withSecret({
      id: randomUUID(),
      name: 'Baraat',
      description: null,
      startsAt: '2026-12-11T14:00:00.000Z',
      endsAt: '2026-12-11T20:00:00.000Z',
      verificationRadiusM: 150,
      venue: { id: HALL, name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 },
    }),
  ];
}

function firstId(schedule: SubEvent[]): string {
  const [first] = schedule;
  if (first === undefined) throw new Error('empty schedule');
  return first.id;
}

let events: FakeEvents;
let subEvents: FakeSubEvents;
let app: RunningApp;
// The event every test works in, with one member per role and status, and its first sub-event.
let eventId: string;
let mehndiId: string;
// Another event, whose Admin is OTHER_ADMIN.
let otherEventId: string;
let otherSubEventId: string;

beforeAll(async () => {
  events = new FakeEvents();
  subEvents = new FakeSubEvents();
  app = await startApp(testDeps({ verifyToken, events, subEvents }));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  events.events.clear();
  subEvents.schedules.clear();
  subEvents.writes.length = 0;
  subEvents.answer = null;
  subEvents.scheduleGone = false;
  subEvents.failWith = null;

  eventId = randomUUID();
  events.events.set(eventId, {
    deleted: false,
    members: new Map([
      [ADMIN, { role: 'admin', status: 'active' }],
      [GUEST, { role: 'guest', status: 'active' }],
      [PHOTOGRAPHER, { role: 'photographer', status: 'active' }],
      [PENDING, { role: 'guest', status: 'pending' }],
      [BLOCKED, { role: 'guest', status: 'blocked' }],
      [REMOVED, { role: 'photographer', status: 'removed' }],
    ]),
  });
  const schedule = seedSchedule();
  subEvents.schedules.set(eventId, schedule);
  mehndiId = firstId(schedule);

  otherEventId = randomUUID();
  events.events.set(otherEventId, {
    deleted: false,
    members: new Map([[OTHER_ADMIN, { role: 'admin', status: 'active' }]]),
  });
  const other = seedSchedule();
  subEvents.schedules.set(otherEventId, other);
  otherSubEventId = firstId(other);
});

function send(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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

function markDeleted(id: string) {
  const event = events.events.get(id);
  if (event === undefined) throw new Error('no such event');
  event.deleted = true;
}

function addBody(overrides: Partial<Record<keyof AddSubEventRequest, unknown>> = {}) {
  return {
    requestId: randomUUID(),
    name: 'Walima',
    startsAt: '2026-12-12T14:00:00.000Z',
    endsAt: '2026-12-12T18:00:00.000Z',
    venue: { id: HALL },
    verificationRadiusM: 200,
    ...overrides,
  };
}

const schedulePath = () => `/events/${eventId}/sub-events`;
const subEventPath = (id: string = mehndiId) => `/sub-events/${id}`;

// The three writes, each against the seeded event's first sub-event or schedule, with a body the
// contract accepts.
const WRITES = [
  ['POST', () => schedulePath(), () => addBody()],
  ['PATCH', () => subEventPath(), () => ({ name: 'Mayun' })],
  ['DELETE', () => subEventPath(), () => undefined],
] as const;

describe('GET /events/{eventId}/sub-events', () => {
  it('answers 401 no_session with no token, and reads nothing', async () => {
    subEvents.failWith = new Error('the store must not be reached');
    const response = await send('GET', schedulePath());
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
  });

  it('answers 400 invalid_request for an id that is not a uuid', async () => {
    const response = await send('GET', '/events/not-a-uuid/sub-events', 'token-admin');
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
  });

  it.each([
    ['the Admin', 'token-admin'],
    ['a Guest', 'token-guest'],
    ['a Photographer', 'token-photographer'],
  ])('returns the schedule to %s, with no qr_secret and no cache', async (_who, token) => {
    const response = await send('GET', schedulePath(), token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toMatch(/qr_?secret/i);
    const body = ListSubEventsResponse.parse(JSON.parse(text));
    expect(body.subEvents.map((s) => s.name)).toEqual(['Mehndi', 'Baraat']);
    expect(body.subEvents[0]).toEqual({
      id: mehndiId,
      name: 'Mehndi',
      description: 'Yellow dress code',
      startsAt: '2026-12-10T14:00:00.000Z',
      endsAt: '2026-12-10T18:00:00.000Z',
      verificationRadiusM: 300,
      venue: { id: HOME, name: 'Family Home', lat: 31.52, lng: 74.35 },
    });
  });

  it.each(NOT_MEMBERS)('answers %s 403 not_member', async (_who, token) => {
    const response = await send('GET', schedulePath(), token);
    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe('not_member');
  });

  it('answers 404 not_found for a soft-deleted event, to its Admin too', async () => {
    markDeleted(eventId);
    for (const token of ['token-admin', 'token-guest', 'token-outsider']) {
      const response = await send('GET', schedulePath(), token);
      expect(response.status).toBe(404);
      await expect(errorCode(response)).resolves.toBe('not_found');
    }
  });

  it('answers 404 not_found for an event that does not exist', async () => {
    const response = await send('GET', `/events/${randomUUID()}/sub-events`, 'token-admin');
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
  });

  it('answers 404 not_found when the event is deleted between the check and the read', async () => {
    subEvents.scheduleGone = true;
    const response = await send('GET', schedulePath(), 'token-guest');
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
  });

  it('answers 500 internal_error, naming no cause, when the store fails', async () => {
    subEvents.failWith = new Error('connection refused to db.example');
    const response = await send('GET', schedulePath(), 'token-guest');
    expect(response.status).toBe(500);
    const body = ErrorResponse.parse(await response.json());
    expect(body.error).toEqual({ code: 'internal_error', message: 'Internal error' });
  });
});

describe('every write', () => {
  it.each(WRITES)(
    '%s answers 401 no_session with no token, and writes nothing',
    async (method, path, body) => {
      const response = await send(method, path(), undefined, body());
      expect(response.status).toBe(401);
      await expect(errorCode(response)).resolves.toBe('no_session');
      expect(subEvents.writes).toEqual([]);
    },
  );

  describe.each(WRITES)('%s', (method, path, body) => {
    it.each(NOT_ADMINS)('answers %s 403 wrong_role, and writes nothing', async (_who, token) => {
      const response = await send(method, path(), token, body());
      expect(response.status).toBe(403);
      await expect(errorCode(response)).resolves.toBe('wrong_role');
      expect(subEvents.writes).toEqual([]);
    });

    // Another event's Admin among them, so an Admin's role never carries across events.
    it.each(NOT_MEMBERS)('answers %s 403 not_member, and writes nothing', async (_who, token) => {
      const seeded = structuredClone(subEvents.schedules.get(eventId));
      const response = await send(method, path(), token, body());
      expect(response.status).toBe(403);
      await expect(errorCode(response)).resolves.toBe('not_member');
      expect(subEvents.writes).toEqual([]);
      expect(subEvents.schedules.get(eventId)).toEqual(seeded);
    });

    it('answers 404 not_found on a soft-deleted event, to its Admin too, and writes nothing', async () => {
      markDeleted(eventId);
      const response = await send(method, path(), 'token-admin', body());
      expect(response.status).toBe(404);
      await expect(errorCode(response)).resolves.toBe('not_found');
      expect(subEvents.writes).toEqual([]);
    });

    it('answers 500 internal_error, naming no cause, when the store fails', async () => {
      subEvents.failWith = new Error('connection refused to db.example');
      const response = await send(method, path(), 'token-admin', body());
      expect(response.status).toBe(500);
      const error = ErrorResponse.parse(await response.json()).error;
      expect(error).toEqual({ code: 'internal_error', message: 'Internal error' });
    });
  });
});

describe('POST /events/{eventId}/sub-events', () => {
  it('answers 201 with the schedule after the add, and hands the store the parsed request', async () => {
    const body = addBody({ name: '  Walima  ', description: 'Reception' });
    const response = await send('POST', schedulePath(), 'token-admin', body);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toMatch(/qr_?secret/i);
    const { subEvents: schedule } = ListSubEventsResponse.parse(JSON.parse(text));
    expect(schedule.map((s) => s.name)).toEqual(['Mehndi', 'Baraat', 'Walima']);
    expect(subEvents.writes).toEqual([
      { kind: 'add', eventId, request: { ...body, name: 'Walima' } },
    ]);
  });

  it('answers 200 with the schedule when the requestId repeated', async () => {
    subEvents.answer = { outcome: 'repeated', subEvents: seedSchedule() } as AddResult;
    const response = await send('POST', schedulePath(), 'token-admin', addBody());
    expect(response.status).toBe(200);
    expect(ListSubEventsResponse.parse(await response.json()).subEvents).toHaveLength(2);
  });

  it('takes a new venue as a name and a pin', async () => {
    const venue = { name: 'Garden', lat: 31.7, lng: 74.5 };
    const response = await send('POST', schedulePath(), 'token-admin', addBody({ venue }));
    expect(response.status).toBe(201);
    expect(subEvents.writes).toMatchObject([{ kind: 'add', request: { venue } }]);
  });

  it('answers 404 not_found for an event that does not exist, and writes nothing', async () => {
    const response = await send(
      'POST',
      `/events/${randomUUID()}/sub-events`,
      'token-admin',
      addBody(),
    );
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
    expect(subEvents.writes).toEqual([]);
  });

  describe('refuses a body the contract refuses with 400 invalid_request, and writes nothing', () => {
    it.each([
      ['no requestId', addBody({ requestId: undefined })],
      ['a requestId that is not a uuid', addBody({ requestId: 'retry-1' })],
      ['a blank name', addBody({ name: ' \t ' })],
      ['an 81-character name', addBody({ name: 'a'.repeat(81) })],
      ['an end equal to the start', addBody({ endsAt: '2026-12-12T14:00:00.000Z' })],
      ['an end before the start', addBody({ endsAt: '2026-12-12T13:00:00.000Z' })],
      ['a time with no fraction', addBody({ startsAt: '2026-12-12T14:00:00Z' })],
      ['a radius under 50', addBody({ verificationRadiusM: 49 })],
      ['a radius over 2000', addBody({ verificationRadiusM: 2001 })],
      ['no venue', addBody({ venue: undefined })],
      ['a venue with an id and a pin', addBody({ venue: { id: HALL, name: 'X', lat: 1, lng: 1 } })],
      ['a venue id that is not a uuid', addBody({ venue: { id: 'hall' } })],
      ['a latitude past 90', addBody({ venue: { name: 'X', lat: 90.5, lng: 1 } })],
      ['a body that is not JSON', '{"requestId":'],
    ])('%s', async (_case, body) => {
      const response = await send('POST', schedulePath(), 'token-admin', body);
      expect(response.status).toBe(400);
      await expect(errorCode(response)).resolves.toBe('invalid_request');
      expect(subEvents.writes).toEqual([]);
    });
  });

  it.each([
    ['taken', 409, 'duplicate'],
    ['no_venue', 400, 'invalid_request'],
    ['too_many', 422, 'too_many_sub_events'],
    ['too_long', 422, 'event_too_long'],
    ['not_found', 404, 'not_found'],
  ])('answers the store refusing with %s as %i %s', async (outcome, status, code) => {
    subEvents.answer = { outcome };
    const response = await send('POST', schedulePath(), 'token-admin', addBody());
    expect(response.status).toBe(status);
    await expect(errorCode(response)).resolves.toBe(code);
  });
});

describe('PATCH /sub-events/{subEventId}', () => {
  it("answers 200 with the schedule after the edit, writing to the sub-event's own event", async () => {
    const response = await send('PATCH', subEventPath(mehndiId.toUpperCase()), 'token-admin', {
      name: 'Mayun',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toMatch(/qr_?secret/i);
    const { subEvents: schedule } = ListSubEventsResponse.parse(JSON.parse(text));
    expect(schedule.map((s) => s.name)).toEqual(['Mayun', 'Baraat']);
    expect(subEvents.writes).toEqual([
      { kind: 'update', eventId, subEventId: mehndiId, request: { name: 'Mayun' } },
    ]);
  });

  it('hands the store a Delay as the two new times, and an empty description as a clear', async () => {
    const delay = {
      startsAt: '2026-12-10T14:30:00.000Z',
      endsAt: '2026-12-10T18:30:00.000Z',
      description: '',
    };
    const response = await send('PATCH', subEventPath(), 'token-admin', delay);
    expect(response.status).toBe(200);
    expect(subEvents.writes).toMatchObject([{ kind: 'update', request: delay }]);
  });

  it('answers 404 not_found for a sub-event that does not exist, and writes nothing', async () => {
    const response = await send('PATCH', subEventPath(randomUUID()), 'token-admin', {
      name: 'Mayun',
    });
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
    expect(subEvents.writes).toEqual([]);
  });

  it("answers an Admin 403 not_member for another event's sub-event, and writes nothing", async () => {
    const response = await send('PATCH', subEventPath(otherSubEventId), 'token-admin', {
      name: 'Hijack',
    });
    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe('not_member');
    expect(subEvents.writes).toEqual([]);
  });

  describe('refuses a body the contract refuses with 400 invalid_request, and writes nothing', () => {
    it.each([
      ['an empty body', {}],
      ['a start with no end', { startsAt: '2026-12-10T15:00:00.000Z' }],
      ['an end with no start', { endsAt: '2026-12-10T19:00:00.000Z' }],
      [
        'an end before the start',
        { startsAt: '2026-12-10T15:00:00.000Z', endsAt: '2026-12-10T14:00:00.000Z' },
      ],
      ['a blank name', { name: '   ' }],
      ['a venue with an id and a pin', { venue: { id: HALL, name: 'X', lat: 1, lng: 1 } }],
      ['a radius over 2000', { verificationRadiusM: 5000 }],
    ])('%s', async (_case, body) => {
      const response = await send('PATCH', subEventPath(), 'token-admin', body);
      expect(response.status).toBe(400);
      await expect(errorCode(response)).resolves.toBe('invalid_request');
      expect(subEvents.writes).toEqual([]);
    });

    it('a sub-event id that is not a uuid', async () => {
      const response = await send('PATCH', subEventPath('mehndi'), 'token-admin', { name: 'X' });
      expect(response.status).toBe(400);
      await expect(errorCode(response)).resolves.toBe('invalid_request');
    });
  });

  it.each([
    ['no_venue', 400, 'invalid_request'],
    ['too_long', 422, 'event_too_long'],
    ['not_found', 404, 'not_found'],
  ])('answers the store refusing with %s as %i %s', async (outcome, status, code) => {
    subEvents.answer = { outcome };
    const response = await send('PATCH', subEventPath(), 'token-admin', { name: 'Mayun' });
    expect(response.status).toBe(status);
    await expect(errorCode(response)).resolves.toBe(code);
  });
});

describe('DELETE /sub-events/{subEventId}', () => {
  it("answers 200 with the schedule after the delete, from the sub-event's own event", async () => {
    const response = await send('DELETE', subEventPath(), 'token-admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { subEvents: schedule } = ListSubEventsResponse.parse(await response.json());
    expect(schedule.map((s) => s.name)).toEqual(['Baraat']);
    expect(subEvents.writes).toEqual([{ kind: 'remove', eventId, subEventId: mehndiId }]);
  });

  it('answers 404 not_found for a sub-event that does not exist, and writes nothing', async () => {
    const response = await send('DELETE', subEventPath(randomUUID()), 'token-admin');
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
    expect(subEvents.writes).toEqual([]);
  });

  it("answers an Admin 403 not_member for another event's sub-event, and writes nothing", async () => {
    const response = await send('DELETE', subEventPath(otherSubEventId), 'token-admin');
    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe('not_member');
    expect(subEvents.writes).toEqual([]);
  });

  it.each([
    ['last', 409, 'last_sub_event'],
    ['not_found', 404, 'not_found'],
    // Any media row, unfinished or soft-deleted included, keeps its sub-event (D-121, S-12).
    ['has_media', 409, 'sub_event_has_media'],
  ])('answers the store refusing with %s as %i %s', async (outcome, status, code) => {
    subEvents.answer = { outcome };
    const response = await send('DELETE', subEventPath(), 'token-admin');
    expect(response.status).toBe(status);
    await expect(errorCode(response)).resolves.toBe(code);
  });
});
