// POST /events, GET /events and the two cover endpoints (D-110, arch §3). The event store is an
// in-memory fake keyed by user, so these tests check what the API does with each answer the store
// gives. rls.test.ts runs the real store, create_event and list_my_events against the dev project.
// URLs are signed by the real R2 presigner with test credentials.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  CreateCoverUploadResponse,
  CreateEventResponse,
  ErrorResponse,
  ListEventsResponse,
  MAX_EVENT_SPAN_MS,
  SetEventCoverResponse,
  VERIFICATION_RADIUS_DEFAULT_M,
} from '@momentlens/shared-types';
import type { CreateEventRequest, MembershipRole, SubEventInput } from '@momentlens/shared-types';

import type { AppDeps } from '../../src/app';
import type { VerifyToken } from '../../src/middleware/auth';
import type {
  CreateEventResult,
  EventAccess,
  EventRecord,
  EventStore,
  MembershipStatus,
} from '../../src/services/events';
import { startApp, TEST_R2, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const A = randomUUID();
const B = randomUUID();

const tokens = new Map([
  ['token-a', A],
  ['token-b', B],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

interface FakeEvent {
  id: string;
  requestId: string;
  name: string;
  type: EventRecord['type'];
  coverKey: string | null;
  startsAt: string;
  endsAt: string;
  archivedAt: string | null;
  deleted: boolean;
  members: Map<string, { role: MembershipRole; status: MembershipStatus }>;
  // A column the real row has and no response may carry, to check the API drops it.
  qrSecret: string;
}

// Answers as create_event and list_my_events do: a repeat from the creator returns the first event,
// anyone else's is taken, a soft-deleted event is gone, and a list holds active memberships only.
class FakeEvents implements EventStore {
  readonly events = new Map<string, FakeEvent>();
  readonly creates: { userId: string; request: CreateEventRequest }[] = [];
  readonly covers: { eventId: string; key: string }[] = [];
  failWith: Error | null = null;
  unknownUsers = new Set<string>();

  seed(
    members: Record<string, [MembershipRole, MembershipStatus]>,
    extra: Partial<FakeEvent> = {},
  ) {
    const event: FakeEvent = {
      id: randomUUID(),
      requestId: randomUUID(),
      name: 'Seeded Event',
      type: 'wedding',
      coverKey: null,
      startsAt: '2026-12-10T14:00:00.000Z',
      endsAt: '2026-12-11T23:00:00.000Z',
      archivedAt: null,
      deleted: false,
      members: new Map(
        Object.entries(members).map(([user, [role, status]]) => [user, { role, status }]),
      ),
      qrSecret: 'c2VjcmV0LXNob3VsZC1uZXZlci1sZWF2ZQ',
      ...extra,
    };
    this.events.set(event.id, event);
    return event;
  }

  private record(event: FakeEvent, userId: string): EventRecord {
    const role = event.members.get(userId)?.role ?? 'guest';
    // Cast: the real store's row parse drops every column the record does not name.
    return {
      id: event.id,
      name: event.name,
      type: event.type,
      role,
      coverKey: event.coverKey,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      archivedAt: event.archivedAt,
      qrSecret: event.qrSecret,
    } as EventRecord;
  }

  create(userId: string, request: CreateEventRequest): Promise<CreateEventResult> {
    this.creates.push({ userId, request });
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.unknownUsers.has(userId)) return Promise.resolve({ outcome: 'no_account' });
    const existing = [...this.events.values()].find((e) => e.requestId === request.requestId);
    if (existing) {
      if (existing.members.get(userId)?.role !== 'admin') {
        return Promise.resolve({ outcome: 'taken' });
      }
      if (existing.deleted) return Promise.resolve({ outcome: 'gone' });
      return Promise.resolve({ outcome: 'repeated', event: this.record(existing, userId) });
    }
    const starts = request.subEvents.map((s) => Date.parse(s.startsAt));
    const ends = request.subEvents.map((s) => Date.parse(s.endsAt));
    const event = this.seed(
      { [userId]: ['admin', 'active'] },
      {
        requestId: request.requestId,
        name: request.name,
        type: request.type,
        startsAt: new Date(Math.min(...starts)).toISOString(),
        endsAt: new Date(Math.max(...ends)).toISOString(),
      },
    );
    return Promise.resolve({ outcome: 'created', event: this.record(event, userId) });
  }

  listForMember(userId: string): Promise<EventRecord[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(
      [...this.events.values()]
        .filter((e) => !e.deleted && e.members.get(userId)?.status === 'active')
        .map((e) => this.record(e, userId)),
    );
  }

  findAccess(eventId: string, userId: string): Promise<EventAccess | null> {
    const event = this.events.get(eventId.toLowerCase());
    if (event === undefined) return Promise.resolve(null);
    return Promise.resolve({
      deleted: event.deleted,
      membership: event.members.get(userId) ?? null,
    });
  }

  setCover(eventId: string, key: string): Promise<boolean> {
    const event = this.events.get(eventId);
    if (event === undefined || event.deleted) return Promise.resolve(false);
    this.covers.push({ eventId, key });
    event.coverKey = key;
    return Promise.resolve(true);
  }
}

let store: FakeEvents;
// Keys the fake R2 has an object at, and every key it was asked about.
let uploaded: Set<string>;
let heads: string[];
let app: RunningApp;

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return testDeps({
    verifyToken,
    events: store,
    objectExists: (key) => {
      heads.push(key);
      return Promise.resolve(uploaded.has(key));
    },
    ...overrides,
  });
}

beforeAll(async () => {
  store = new FakeEvents();
  uploaded = new Set();
  heads = [];
  app = await startApp(deps());
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.events.clear();
  store.creates.length = 0;
  store.covers.length = 0;
  store.failWith = null;
  store.unknownUsers.clear();
  uploaded.clear();
  heads.length = 0;
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
    init.body =
      typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
  }
  return fetch(`${app.baseUrl}${path}`, init);
}

async function errorCode(response: Response): Promise<string> {
  return ErrorResponse.parse(await response.json()).error.code;
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-12-10T14:00:00.000Z');

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// A sub-event at the slider's starting radius, unless the case sets its own (D-111).
function subEvent(
  fields: Omit<SubEventInput, 'verificationRadiusM'> & { verificationRadiusM?: number },
): SubEventInput {
  return { verificationRadiusM: VERIFICATION_RADIUS_DEFAULT_M, ...fields };
}

function validRequest(overrides: Partial<CreateEventRequest> = {}): CreateEventRequest {
  return {
    requestId: randomUUID(),
    name: 'Ayesha & Bilal',
    type: 'wedding',
    approvalMode: 'auto',
    venues: [
      { name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 },
      { name: 'Family Home', lat: 31.52, lng: 74.35 },
    ],
    subEvents: [
      subEvent({ name: 'Mehndi', startsAt: iso(T0), endsAt: iso(T0 + 4 * HOUR), venueIndex: 1 }),
      subEvent({
        name: 'Baraat',
        startsAt: iso(T0 + 24 * HOUR),
        endsAt: iso(T0 + 30 * HOUR),
        venueIndex: 0,
      }),
    ],
    ...overrides,
  };
}

function subEvents(count: number) {
  return Array.from({ length: count }, (_, i) =>
    subEvent({
      name: `Sub-event ${i + 1}`,
      startsAt: iso(T0 + i * HOUR),
      endsAt: iso(T0 + i * HOUR + HOUR / 2),
      venueIndex: 0,
    }),
  );
}

// One venue per sub-event, sub-event i at venue i.
function venues(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Venue ${i + 1}`,
    lat: 31.5 + i / 100,
    lng: 74.3,
  }));
}

describe('POST /events', () => {
  it('answers 401 no_session with no token, and creates nothing', async () => {
    const response = await send('POST', '/events', undefined, validRequest());
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
    expect(store.creates).toEqual([]);
  });

  it('creates the event with the caller as its Admin, and answers 201', async () => {
    const request = validRequest();
    const response = await send('POST', '/events', 'token-a', request);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const { event } = CreateEventResponse.parse(await response.json());
    expect(event).toMatchObject({
      name: 'Ayesha & Bilal',
      type: 'wedding',
      role: 'admin',
      cover: null,
      startsAt: iso(T0),
      endsAt: iso(T0 + 30 * HOUR),
      archivedAt: null,
    });
    expect(store.creates).toEqual([{ userId: A, request }]);
  });

  it('returns the first event with 200 when the same caller repeats a requestId', async () => {
    const request = validRequest();
    const first = CreateEventResponse.parse(
      await (await send('POST', '/events', 'token-a', request)).json(),
    );
    const again = await send('POST', '/events', 'token-a', request);
    expect(again.status).toBe(200);
    expect(CreateEventResponse.parse(await again.json()).event.id).toBe(first.event.id);
    expect(store.events.size).toBe(1);
  });

  it("never returns A's event to B reusing A's requestId", async () => {
    const request = validRequest();
    const first = CreateEventResponse.parse(
      await (await send('POST', '/events', 'token-a', request)).json(),
    );
    const response = await send('POST', '/events', 'token-b', { ...request, name: 'B event' });
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe('duplicate');
    expect(text).not.toContain(first.event.id);
    expect(text).not.toContain('Ayesha');
    expect(store.events.size).toBe(1);
  });

  it('answers 404 not_found when the repeated event has been deleted since', async () => {
    const request = validRequest();
    const first = CreateEventResponse.parse(
      await (await send('POST', '/events', 'token-a', request)).json(),
    );
    const created = store.events.get(first.event.id);
    if (created) created.deleted = true;
    const response = await send('POST', '/events', 'token-a', request);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  it('answers 401 no_session when the account was deleted after the token was issued', async () => {
    store.unknownUsers.add(A);
    const response = await send('POST', '/events', 'token-a', validRequest());
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
  });

  it('answers 500 internal_error, naming no cause, when the store fails', async () => {
    store.failWith = new Error('connection to db.example.supabase.co refused');
    const response = await send('POST', '/events', 'token-a', validRequest());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(ErrorResponse.parse(JSON.parse(text)).error.code).toBe('internal_error');
    expect(text).not.toContain('supabase');
  });

  describe('refuses a body past a limit with 400 invalid_request, and creates nothing', () => {
    const cases: [string, unknown][] = [
      ['no sub-events', validRequest({ subEvents: [], venues: [validRequest().venues[0]!] })],
      [
        '16 sub-events',
        validRequest({ subEvents: subEvents(16), venues: [validRequest().venues[0]!] }),
      ],
      [
        'a span one millisecond over 336 hours',
        validRequest({
          subEvents: [
            subEvent({ name: 'First', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }),
            subEvent({
              name: 'Last',
              startsAt: iso(T0 + 2 * HOUR),
              endsAt: iso(T0 + MAX_EVENT_SPAN_MS + 1),
              venueIndex: 1,
            }),
          ],
        }),
      ],
      [
        'a sub-event ending when it starts',
        validRequest({
          subEvents: [
            subEvent({ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0), venueIndex: 0 }),
          ],
          venues: [validRequest().venues[0]!],
        }),
      ],
      [
        'a sub-event ending before it starts',
        validRequest({
          subEvents: [
            subEvent({ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0 - 1), venueIndex: 0 }),
          ],
          venues: [validRequest().venues[0]!],
        }),
      ],
      ...[49, 2001, 200.5].map((radius): [string, unknown] => [
        `a sub-event radius of ${radius} m`,
        validRequest({
          subEvents: [
            subEvent({ name: 'Mehndi', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 1 }),
            subEvent({
              name: 'Baraat',
              startsAt: iso(T0 + 24 * HOUR),
              endsAt: iso(T0 + 30 * HOUR),
              venueIndex: 0,
              verificationRadiusM: radius,
            }),
          ],
        }),
      ]),
      [
        // What a client written for D-110's contract sends: one radius for the event, none on
        // its sub-events.
        'a radius on the event and none on its sub-event',
        {
          ...validRequest({ venues: [validRequest().venues[0]!] }),
          verificationRadiusM: 200,
          subEvents: [{ name: 'Nikkah', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }],
        },
      ],
      ['an unknown approval mode', { ...validRequest(), approvalMode: 'invite_only' }],
      ['a null approval mode', { ...validRequest(), approvalMode: null }],
      [
        'a venue index out of range',
        validRequest({
          subEvents: [
            subEvent({ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 2 }),
          ],
        }),
      ],
      [
        'a negative venue index',
        validRequest({
          subEvents: [
            subEvent({ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: -1 }),
          ],
        }),
      ],
      [
        // The event has no venue of its own, so venues[0] needs a sub-event too (D-111).
        'a first venue no sub-event uses',
        validRequest({
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
        }),
      ],
      [
        '16 venues for 15 sub-events',
        validRequest({ subEvents: subEvents(15), venues: venues(16) }),
      ],
      [
        'an extra venue no sub-event uses',
        validRequest({
          subEvents: [
            subEvent({ name: 'Walima', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }),
          ],
        }),
      ],
      ['no venues', validRequest({ venues: [] })],
      ['a blank name', validRequest({ name: ' 　 ' })],
      ['an 81-character name', validRequest({ name: 'a'.repeat(81) })],
      ['a 501-character description', validRequest({ description: 'd'.repeat(501) })],
      ['an unknown type', { ...validRequest(), type: 'party' }],
      ['a requestId that is not a uuid', { ...validRequest(), requestId: 'retry-1' }],
      ['no requestId', { ...validRequest(), requestId: undefined }],
      [
        'a time with an offset instead of Z',
        validRequest({
          subEvents: [
            subEvent({
              name: 'Mehndi',
              startsAt: '2026-12-10T19:00:00.000+05:00',
              endsAt: iso(T0 + HOUR),
              venueIndex: 0,
            }),
          ],
          venues: [validRequest().venues[0]!],
        }),
      ],
      ['a latitude of 91', validRequest({ venues: [{ name: 'Nowhere', lat: 91, lng: 0 }] })],
      ['an array', [validRequest()]],
    ];

    it.each(cases)('%s', async (_case, body) => {
      const response = await send('POST', '/events', 'token-a', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
      expect(store.creates).toEqual([]);
    });

    it('a body that is not JSON', async () => {
      const response = await send('POST', '/events', 'token-a', '{"name": ');
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
      expect(store.creates).toEqual([]);
    });

    it('no body at all', async () => {
      const response = await send('POST', '/events', 'token-a');
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
    });

    it('a JSON body sent as text/plain', async () => {
      const response = await send('POST', '/events', 'token-a', JSON.stringify(validRequest()), {
        'Content-Type': 'text/plain',
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
    });
  });

  it.each([
    [
      '15 sub-events',
      validRequest({ subEvents: subEvents(15), venues: [validRequest().venues[0]!] }),
    ],
    [
      'a span of exactly 336 hours',
      validRequest({
        subEvents: [
          subEvent({ name: 'First', startsAt: iso(T0), endsAt: iso(T0 + HOUR), venueIndex: 0 }),
          subEvent({
            name: 'Last',
            startsAt: iso(T0 + 2 * HOUR),
            endsAt: iso(T0 + MAX_EVENT_SPAN_MS),
            venueIndex: 1,
          }),
        ],
      }),
    ],
    ...[50, 2000].map((radius): [string, CreateEventRequest] => [
      `a sub-event radius of ${radius} m`,
      validRequest({
        subEvents: [
          subEvent({
            name: 'Nikkah',
            startsAt: iso(T0),
            endsAt: iso(T0 + HOUR),
            venueIndex: 0,
            verificationRadiusM: radius,
          }),
        ],
        venues: [validRequest().venues[0]!],
      }),
    ]),
    [
      '15 sub-events at 15 venues',
      validRequest({
        subEvents: subEvents(15).map((s, i) => ({ ...s, venueIndex: i })),
        venues: venues(15),
      }),
    ],
    [
      'a sub-event that started in the past',
      validRequest({
        subEvents: [
          subEvent({
            name: 'Dholki',
            startsAt: iso(Date.now() - 3 * HOUR),
            endsAt: iso(Date.now() + HOUR),
            venueIndex: 0,
          }),
        ],
        venues: [validRequest().venues[0]!],
      }),
    ],
    [
      'overlapping sub-events at one venue',
      validRequest({
        subEvents: [
          subEvent({
            name: 'Nikkah',
            startsAt: iso(T0),
            endsAt: iso(T0 + 2 * HOUR),
            venueIndex: 0,
          }),
          subEvent({
            name: 'Rukhsati',
            startsAt: iso(T0 + HOUR),
            endsAt: iso(T0 + 3 * HOUR),
            venueIndex: 0,
          }),
        ],
        venues: [validRequest().venues[0]!],
      }),
    ],
  ])('accepts %s', async (_case, body) => {
    const response = await send('POST', '/events', 'token-a', body);
    expect(response.status).toBe(201);
  });

  it('passes the store only fields the contract names, never a key or a secret from the body', async () => {
    const request = validRequest();
    await send('POST', '/events', 'token-a', {
      ...request,
      coverKey: `events/${randomUUID()}/cover_${randomUUID()}.jpg`,
      qrSecret: 'chosen-by-the-client',
      userId: B,
      // D-110's event-wide radius and event venue, which D-111 removed.
      verificationRadiusM: 2000,
      venueId: randomUUID(),
    });
    expect(store.creates).toEqual([{ userId: A, request }]);
  });

  it("passes each sub-event's own radius to the store", async () => {
    const request = validRequest({
      subEvents: [
        subEvent({
          name: 'Nikkah',
          startsAt: iso(T0),
          endsAt: iso(T0 + 2 * HOUR),
          venueIndex: 0,
          verificationRadiusM: 150,
        }),
        subEvent({
          name: 'Walima',
          startsAt: iso(T0 + 24 * HOUR),
          endsAt: iso(T0 + 28 * HOUR),
          venueIndex: 0,
          verificationRadiusM: 600,
        }),
      ],
      venues: [validRequest().venues[0]!],
    });
    const response = await send('POST', '/events', 'token-a', request);
    expect(response.status).toBe(201);
    expect(store.creates[0]?.request.subEvents.map((s) => s.verificationRadiusM)).toEqual([
      150, 600,
    ]);
  });

  it('passes a manual approval mode to the store', async () => {
    const request = validRequest({ approvalMode: 'manual' });
    const response = await send('POST', '/events', 'token-a', request);
    expect(response.status).toBe(201);
    expect(store.creates[0]?.request.approvalMode).toBe('manual');
  });

  it('passes auto to the store when the body leaves the approval mode out', async () => {
    const body: Record<string, unknown> = { ...validRequest() };
    delete body.approvalMode;
    const response = await send('POST', '/events', 'token-a', body);
    expect(response.status).toBe(201);
    expect(store.creates[0]?.request.approvalMode).toBe('auto');
  });
});

describe('GET /events', () => {
  it('answers 401 no_session with no token', async () => {
    const response = await send('GET', '/events');
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('no_session');
  });

  it("lists the caller's events with their role, and never another user's", async () => {
    const mine = store.seed({ [A]: ['admin', 'active'] }, { name: 'Mine' });
    const guestOf = store.seed(
      { [B]: ['admin', 'active'], [A]: ['guest', 'active'] },
      { name: 'Invited' },
    );
    store.seed({ [B]: ['admin', 'active'] }, { name: 'Only B' });

    const response = await send('GET', '/events', 'token-a');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const { events } = ListEventsResponse.parse(JSON.parse(text));
    expect(events.map((e) => [e.id, e.role]).sort()).toEqual(
      [
        [mine.id, 'admin'],
        [guestOf.id, 'guest'],
      ].sort(),
    );
    expect(text).not.toContain('Only B');
  });

  it.each(['pending', 'blocked', 'removed'] as const)(
    'leaves out an event where the caller is %s',
    async (status) => {
      store.seed({ [B]: ['admin', 'active'], [A]: ['guest', status] });
      const { events } = ListEventsResponse.parse(
        await (await send('GET', '/events', 'token-a')).json(),
      );
      expect(events).toEqual([]);
    },
  );

  it('leaves out a soft-deleted event', async () => {
    store.seed({ [A]: ['admin', 'active'] }, { deleted: true });
    const { events } = ListEventsResponse.parse(
      await (await send('GET', '/events', 'token-a')).json(),
    );
    expect(events).toEqual([]);
  });

  it('answers an empty list, not an error, for a user in no event', async () => {
    const response = await send('GET', '/events', 'token-b');
    expect(response.status).toBe(200);
    expect(ListEventsResponse.parse(await response.json())).toEqual({ events: [] });
  });

  it('never sends a QR secret, whatever the store row carries', async () => {
    const event = store.seed({ [A]: ['admin', 'active'] });
    const text = await (await send('GET', '/events', 'token-a')).text();
    expect(text).not.toContain(event.qrSecret);
    expect(text.toLowerCase()).not.toContain('qr');
  });

  it('presigns the cover for the caller, cached by its key, never a bucket URL', async () => {
    const eventId = randomUUID();
    const key = `events/${eventId}/cover_${randomUUID()}.jpg`;
    store.seed({ [A]: ['guest', 'active'] }, { id: eventId, coverKey: key });

    const { events } = ListEventsResponse.parse(
      await (await send('GET', '/events', 'token-a')).json(),
    );
    const cover = events[0]?.cover;
    expect(cover?.cacheKey).toBe(key);
    const url = new URL(cover?.url ?? '');
    expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers 500 rather than send a stored name the contract rejects', async () => {
    store.seed({ [A]: ['admin', 'active'] }, { name: '   ' });
    const response = await send('GET', '/events', 'token-a');
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('internal_error');
  });
});

describe('the cover endpoints', () => {
  let event: FakeEvent;
  const G = randomUUID();
  const P = randomUUID();
  const PENDING = randomUUID();
  const BLOCKED = randomUUID();
  const REMOVED = randomUUID();

  beforeAll(() => {
    tokens.set('token-guest', G);
    tokens.set('token-photographer', P);
    tokens.set('token-pending', PENDING);
    tokens.set('token-blocked', BLOCKED);
    tokens.set('token-removed', REMOVED);
  });

  beforeEach(() => {
    event = store.seed({
      [A]: ['admin', 'active'],
      [G]: ['guest', 'active'],
      [P]: ['photographer', 'active'],
      [PENDING]: ['guest', 'pending'],
      [BLOCKED]: ['guest', 'blocked'],
      [REMOVED]: ['guest', 'removed'],
    });
  });

  function uploadedCover(eventId = event.id): { uploadId: string; key: string } {
    const uploadId = randomUUID();
    const key = `events/${eventId}/cover_${uploadId}.jpg`;
    uploaded.add(key);
    return { uploadId, key };
  }

  // Each refusal is checked on both endpoints, and on each the HEAD never runs, so a caller who
  // may not set the cover cannot learn whether an object exists.
  const refusals: [string, string, number, string][] = [
    ['another user, in no role', 'token-b', 403, 'not_member'],
    ['a pending member', 'token-pending', 403, 'not_member'],
    ['a blocked member', 'token-blocked', 403, 'not_member'],
    ['a removed member', 'token-removed', 403, 'not_member'],
    ['a Guest', 'token-guest', 403, 'wrong_role'],
    ['a Photographer', 'token-photographer', 403, 'wrong_role'],
  ];

  describe('POST /events/{eventId}/cover-upload', () => {
    it('answers 401 no_session with no token', async () => {
      const response = await send('POST', `/events/${event.id}/cover-upload`);
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('no_session');
    });

    it.each(refusals)('refuses %s', async (_who, token, status, code) => {
      const response = await send('POST', `/events/${event.id}/cover-upload`, token);
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    });

    it("refuses A for another event's cover, where A is no member", async () => {
      const other = store.seed({ [B]: ['admin', 'active'] });
      const response = await send('POST', `/events/${other.id}/cover-upload`, 'token-a');
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('not_member');
    });

    it('answers 404 not_found for a soft-deleted event, to its Admin too', async () => {
      event.deleted = true;
      const response = await send('POST', `/events/${event.id}/cover-upload`, 'token-a');
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    });

    it('answers 404 not_found for an event that does not exist', async () => {
      const response = await send('POST', `/events/${randomUUID()}/cover-upload`, 'token-a');
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    });

    it('answers 400 invalid_request for an event id that is not a uuid', async () => {
      const response = await send('POST', '/events/not-a-uuid/cover-upload', 'token-a');
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
    });

    it("gives the Admin a 15-minute PUT URL for a fresh key under this event's covers", async () => {
      const response = await send('POST', `/events/${event.id}/cover-upload`, 'token-a');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = CreateCoverUploadResponse.parse(await response.json());

      const url = new URL(body.uploadUrl);
      expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
      expect(url.pathname).toBe(`/events/${event.id}/cover_${body.uploadId}.jpg`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-type');

      const second = CreateCoverUploadResponse.parse(
        await (await send('POST', `/events/${event.id}/cover-upload`, 'token-a')).json(),
      );
      expect(second.uploadId).not.toBe(body.uploadId);
    });
  });

  describe('PUT /events/{eventId}/cover', () => {
    it('answers 401 no_session with no token', async () => {
      const { uploadId } = uploadedCover();
      const response = await send('PUT', `/events/${event.id}/cover`, undefined, { uploadId });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe('no_session');
    });

    it.each(refusals)(
      'refuses %s, and never HEADs the object',
      async (_who, token, status, code) => {
        const { uploadId } = uploadedCover();
        const response = await send('PUT', `/events/${event.id}/cover`, token, { uploadId });
        expect(response.status).toBe(status);
        expect(await errorCode(response)).toBe(code);
        expect(heads).toEqual([]);
        expect(store.covers).toEqual([]);
      },
    );

    it('answers 404 not_found for a soft-deleted event, and never HEADs the object', async () => {
      const { uploadId } = uploadedCover();
      event.deleted = true;
      const response = await send('PUT', `/events/${event.id}/cover`, 'token-a', { uploadId });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
      expect(heads).toEqual([]);
    });

    it.each([
      ['an uploadId that is not a uuid', { uploadId: 'cover.jpg' }],
      ['no uploadId', {}],
      [
        'a key in place of an uploadId',
        { key: `events/${randomUUID()}/cover_${randomUUID()}.jpg` },
      ],
    ])('answers 400 invalid_request for %s', async (_case, body) => {
      const response = await send('PUT', `/events/${event.id}/cover`, 'token-a', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
      expect(store.covers).toEqual([]);
    });

    it('refuses image bytes sent to the API, which only ever takes the uploadId (invariant 5)', async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(1024).fill(0)]);
      const response = await send('PUT', `/events/${event.id}/cover`, 'token-a', jpeg, {
        'Content-Type': 'image/jpeg',
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
      expect(heads).toEqual([]);
      expect(store.covers).toEqual([]);
    });

    it('answers 409 upload_missing for an uploadId never uploaded', async () => {
      const response = await send('PUT', `/events/${event.id}/cover`, 'token-a', {
        uploadId: randomUUID(),
      });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('upload_missing');
      expect(store.covers).toEqual([]);
    });

    it("answers 409 upload_missing for an uploadId presigned for another event, even A's own", async () => {
      const other = store.seed({ [A]: ['admin', 'active'] });
      const { uploadId, key } = uploadedCover(other.id);
      const response = await send('PUT', `/events/${event.id}/cover`, 'token-a', { uploadId });
      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('upload_missing');
      expect(heads).toEqual([`events/${event.id}/cover_${uploadId}.jpg`]);
      expect(heads).not.toContain(key);
      expect(store.covers).toEqual([]);
    });

    it("sets the cover from the path's event and the uploadId, ignoring a key in the body", async () => {
      const { uploadId, key } = uploadedCover();
      const elsewhere = `events/${randomUUID()}/cover_${randomUUID()}.jpg`;
      uploaded.add(elsewhere);

      const response = await send('PUT', `/events/${event.id}/cover`, 'token-a', {
        uploadId,
        key: elsewhere,
        coverKey: elsewhere,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(store.covers).toEqual([{ eventId: event.id, key }]);

      const { cover } = SetEventCoverResponse.parse(await response.json());
      expect(cover.cacheKey).toBe(key);
      const url = new URL(cover.url);
      expect(url.hostname).toBe(`${TEST_R2.bucket}.${TEST_R2.accountId}.r2.cloudflarestorage.com`);
      expect(url.pathname).toBe(`/${key}`);
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('treats an uppercase event id as the same event, and stores the lowercase key', async () => {
      const { uploadId, key } = uploadedCover();
      const response = await send('PUT', `/events/${event.id.toUpperCase()}/cover`, 'token-a', {
        uploadId: uploadId.toUpperCase(),
      });
      expect(response.status).toBe(200);
      expect(store.covers).toEqual([{ eventId: event.id, key }]);
    });

    it('sets the same cover again when the uploadId repeats', async () => {
      const { uploadId, key } = uploadedCover();
      await send('PUT', `/events/${event.id}/cover`, 'token-a', { uploadId });
      const again = await send('PUT', `/events/${event.id}/cover`, 'token-a', { uploadId });
      expect(again.status).toBe(200);
      expect(store.covers).toEqual([
        { eventId: event.id, key },
        { eventId: event.id, key },
      ]);
    });

    it('answers 404 not_found when the event is deleted between the check and the write', async () => {
      const { uploadId } = uploadedCover();
      const racing = await startApp(
        deps({
          events: Object.assign(Object.create(store) as FakeEvents, {
            setCover: () => Promise.resolve(false),
          }),
        }),
      );
      try {
        const response = await fetch(`${racing.baseUrl}/events/${event.id}/cover`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer token-a', 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        });
        expect(response.status).toBe(404);
        expect(await errorCode(response)).toBe('not_found');
      } finally {
        await racing.close();
      }
    });
  });
});
