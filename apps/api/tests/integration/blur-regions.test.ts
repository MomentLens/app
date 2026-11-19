// POST and GET /media/{mediaId}/blur-regions and DELETE /blur-regions/{regionId} (D-83, D-170,
// spec §4.11.4.4, arch:manual_blur_region). The store is a fake that answers as add_blur_region and
// remove_blur_region do, so these check what the service does with each answer. rls.test.ts runs
// the real functions against the dev project, the one-message-per-change check included.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { ErrorResponse, ListBlurRegionsResponse } from '@momentlens/shared-types';
import type {
  AddBlurRegionRequest,
  BlurRegion,
  MembershipRole,
  MembershipStatus,
} from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type {
  AddRegionResult,
  BlurRegionStore,
  PhotoAccess,
  RemoveRegionResult,
} from '../../src/services/blur-regions';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const ADMIN = randomUUID();
const GUEST = randomUUID();
const OTHER_GUEST = randomUUID();
const PHOTOGRAPHER = randomUUID();
const PENDING = randomUUID();
const BLOCKED = randomUUID();
const REMOVED = randomUUID();
const OUTSIDER = randomUUID();
const OTHER_EVENT_ADMIN = randomUUID();

const tokens = new Map([
  ['admin', ADMIN],
  ['guest', GUEST],
  ['other-guest', OTHER_GUEST],
  ['photographer', PHOTOGRAPHER],
  ['pending', PENDING],
  ['blocked', BLOCKED],
  ['removed', REMOVED],
  ['outsider', OUTSIDER],
  ['other-event-admin', OTHER_EVENT_ADMIN],
]);

const NAMES = new Map<string, string>([
  [ADMIN, 'Admin Person'],
  [GUEST, 'Guest Person'],
  [OTHER_GUEST, 'Other Guest'],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

// Everyone the card names who must get 403 not_member, by token.
const NOT_MEMBERS = [
  ['a pending member', 'pending'],
  ['a blocked member', 'blocked'],
  ['a removed member', 'removed'],
  ['someone with no membership', 'outsider'],
  ["another event's Admin", 'other-event-admin'],
] as const;

interface Photo {
  eventId: string;
  processed: boolean;
  deleted: boolean;
}

interface StoredRegion {
  id: string;
  mediaId: string;
  drawnBy: string;
  rect: { x: number; y: number; width: number; height: number };
  createdAt: string;
}

// Answers as the SQL functions do, refusal order included, and counts the messages it would send.
class FakeBlurRegions implements BlurRegionStore {
  readonly eventsDeleted = new Map<string, boolean>();
  readonly members = new Map<
    string,
    Map<string, { role: MembershipRole; status: MembershipStatus }>
  >();
  readonly photos = new Map<string, Photo>();
  regions: StoredRegion[] = [];
  messages: string[] = [];
  private clock = Date.parse('2026-12-10T14:00:00.000Z');

  private check(mediaId: string, userId: string): PhotoAccess {
    const photo = this.photos.get(mediaId);
    if (
      photo === undefined ||
      !photo.processed ||
      photo.deleted ||
      this.eventsDeleted.get(photo.eventId) !== false
    ) {
      return { outcome: 'not_found' };
    }
    const membership = this.members.get(photo.eventId)?.get(userId);
    if (membership?.status !== 'active') return { outcome: 'not_member' };
    return { outcome: 'active', role: membership.role };
  }

  access(mediaId: string, userId: string): Promise<PhotoAccess> {
    return Promise.resolve(this.check(mediaId, userId));
  }

  list(mediaId: string, drawnBy: string | null): Promise<BlurRegion[]> {
    return Promise.resolve(
      this.regions
        .filter((r) => r.mediaId === mediaId && (drawnBy === null || r.drawnBy === drawnBy))
        .map((r) => ({
          id: r.id,
          ...r.rect,
          drawnBy: { userId: r.drawnBy, fullName: NAMES.get(r.drawnBy) ?? 'Someone' },
          createdAt: r.createdAt,
        })),
    );
  }

  add(userId: string, mediaId: string, request: AddBlurRegionRequest): Promise<AddRegionResult> {
    const access = this.check(mediaId, userId);
    if (access.outcome !== 'active') return Promise.resolve({ outcome: access.outcome });
    if (access.role === 'photographer') return Promise.resolve({ outcome: 'wrong_role' });
    const { id, ...rect } = request;
    const existing = this.regions.find((r) => r.id === id);
    if (existing !== undefined) {
      const repeat = existing.mediaId === mediaId && existing.drawnBy === userId;
      return Promise.resolve(
        repeat ? { outcome: 'repeat', role: access.role } : { outcome: 'duplicate' },
      );
    }
    this.clock += 1000;
    this.regions.push({
      id,
      mediaId,
      drawnBy: userId,
      rect,
      createdAt: new Date(this.clock).toISOString(),
    });
    this.messages.push(mediaId);
    return Promise.resolve({ outcome: 'added', role: access.role });
  }

  remove(regionId: string, userId: string): Promise<RemoveRegionResult> {
    const region = this.regions.find((r) => r.id === regionId);
    if (region === undefined) return Promise.resolve({ outcome: 'not_found' });
    const access = this.check(region.mediaId, userId);
    if (access.outcome !== 'active') return Promise.resolve({ outcome: access.outcome });
    if (access.role === 'photographer') return Promise.resolve({ outcome: 'wrong_role' });
    if (access.role !== 'admin' && region.drawnBy !== userId) {
      return Promise.resolve({ outcome: 'not_drawer' });
    }
    this.regions = this.regions.filter((r) => r.id !== regionId);
    this.messages.push(region.mediaId);
    return Promise.resolve({ outcome: 'removed', role: access.role, mediaId: region.mediaId });
  }
}

let store: FakeBlurRegions;
let app: RunningApp;
let eventId: string;
let photoId: string;

beforeAll(async () => {
  store = new FakeBlurRegions();
  app = await startApp(testDeps({ verifyToken, blurRegions: store }));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.eventsDeleted.clear();
  store.members.clear();
  store.photos.clear();
  store.regions = [];
  store.messages = [];

  eventId = randomUUID();
  const otherEventId = randomUUID();
  photoId = randomUUID();
  store.eventsDeleted.set(eventId, false);
  store.eventsDeleted.set(otherEventId, false);
  store.members.set(
    eventId,
    new Map([
      [ADMIN, { role: 'admin', status: 'active' }],
      [GUEST, { role: 'guest', status: 'active' }],
      [OTHER_GUEST, { role: 'guest', status: 'active' }],
      [PHOTOGRAPHER, { role: 'photographer', status: 'active' }],
      [PENDING, { role: 'guest', status: 'pending' }],
      [BLOCKED, { role: 'guest', status: 'blocked' }],
      [REMOVED, { role: 'guest', status: 'removed' }],
    ]),
  );
  store.members.set(
    otherEventId,
    new Map([[OTHER_EVENT_ADMIN, { role: 'admin', status: 'active' }]]),
  );
  store.photos.set(photoId, { eventId, processed: true, deleted: false });
});

const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };

function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${app.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const add = (
  token: string | null,
  mediaId = photoId,
  body: unknown = { id: randomUUID(), ...RECT },
) => call('POST', `/media/${mediaId}/blur-regions`, token, body);
const list = (token: string | null, mediaId = photoId) =>
  call('GET', `/media/${mediaId}/blur-regions`, token);
const remove = (token: string | null, regionId: string) =>
  call('DELETE', `/blur-regions/${regionId}`, token);

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = ErrorResponse.parse(await res.json());
  expect(body.error.code).toBe(code);
}

async function regionsOf(res: Response, status = 200) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return ListBlurRegionsResponse.parse(await res.json()).regions;
}

// A region stored directly, as if drawn earlier.
function seed(drawnBy: string, mediaId = photoId): string {
  const id = randomUUID();
  store.regions.push({
    id,
    mediaId,
    drawnBy,
    rect: RECT,
    createdAt: new Date(
      Date.parse('2026-12-10T13:00:00.000Z') + store.regions.length,
    ).toISOString(),
  });
  return id;
}

// The refusals every endpoint shares, by photo. `send` makes the request for one token and photo,
// and for DELETE seeds a region on that photo first.
const ENDPOINTS: [string, (token: string | null, mediaId: string) => Promise<Response>][] = [
  ['POST', (token, mediaId) => add(token, mediaId)],
  ['GET', (token, mediaId) => list(token, mediaId)],
  ['DELETE', (token, mediaId) => remove(token, seed(GUEST, mediaId))],
];

describe.each(ENDPOINTS)('%s refusals', (_method, send) => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    await expectError(await send(null, photoId), 401, 'no_session');
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      await expectError(await send(token, photoId), 403, 'not_member');
    });
  }

  it('refuses a Photographer with 403 wrong_role', async () => {
    await expectError(await send('photographer', photoId), 403, 'wrong_role');
  });

  it('answers a photo the worker has not finished with 404', async () => {
    store.photos.set(photoId, { eventId, processed: false, deleted: false });
    await expectError(await send('admin', photoId), 404, 'not_found');
  });

  it('answers a deleted photo with 404', async () => {
    store.photos.set(photoId, { eventId, processed: true, deleted: true });
    await expectError(await send('admin', photoId), 404, 'not_found');
  });

  it('answers a photo in a deleted event with 404', async () => {
    store.eventsDeleted.set(eventId, true);
    await expectError(await send('admin', photoId), 404, 'not_found');
  });

  it('sends no message on any refusal', async () => {
    await send('photographer', photoId);
    await send('outsider', photoId);
    expect(store.messages).toEqual([]);
  });
});

describe('POST /media/:mediaId/blur-regions', () => {
  it('answers an unknown photo with 404', async () => {
    await expectError(await add('guest', randomUUID()), 404, 'not_found');
  });

  it('refuses a path id that is not a uuid with 400', async () => {
    await expectError(await add('guest', 'not-a-uuid'), 400, 'invalid_request');
  });

  it.each([
    ['past the right edge', { x: 0.8, y: 0, width: 0.3, height: 0.1 }],
    ['past the bottom edge', { x: 0, y: 0.9, width: 0.1, height: 0.2 }],
    ['with no width', { x: 0.1, y: 0.1, width: 0, height: 0.1 }],
    ['with no height', { x: 0.1, y: 0.1, width: 0.1, height: 0 }],
    ['below 0', { x: -0.1, y: 0.1, width: 0.1, height: 0.1 }],
  ])('refuses a rectangle %s with 400', async (_case, rect) => {
    await expectError(
      await add('guest', photoId, { id: randomUUID(), ...rect }),
      400,
      'invalid_request',
    );
    expect(store.messages).toEqual([]);
  });

  it('refuses a body with another field, or with no id, with 400', async () => {
    await expectError(
      await add('guest', photoId, { id: randomUUID(), ...RECT, drawnBy: ADMIN }),
      400,
      'invalid_request',
    );
    await expectError(await add('guest', photoId, RECT), 400, 'invalid_request');
  });

  it('stores a Guest region with 201, answers their list, and sends one message', async () => {
    const id = randomUUID();
    const regions = await regionsOf(await add('guest', photoId, { id, ...RECT }), 201);
    expect(regions).toEqual([
      {
        id,
        ...RECT,
        drawnBy: { userId: GUEST, fullName: 'Guest Person' },
        createdAt: expect.any(String),
      },
    ]);
    expect(store.messages).toEqual([photoId]);
  });

  it('answers a Guest with only their own regions after the write', async () => {
    seed(OTHER_GUEST);
    const regions = await regionsOf(await add('guest'), 201);
    expect(regions.map((r) => r.drawnBy.userId)).toEqual([GUEST]);
  });

  it('answers the Admin with every region after the write', async () => {
    seed(GUEST);
    const regions = await regionsOf(await add('admin'), 201);
    expect(regions.map((r) => r.drawnBy.userId)).toEqual([GUEST, ADMIN]);
  });

  it('answers a repeat of the same id 200, storing and sending nothing new', async () => {
    const body = { id: randomUUID(), ...RECT };
    await regionsOf(await add('guest', photoId, body), 201);
    const again = await regionsOf(await add('guest', photoId, { ...body, x: 0.5 }), 200);
    expect(again).toHaveLength(1);
    expect(again[0]?.x).toBe(RECT.x);
    expect(store.messages).toHaveLength(1);
  });

  it("refuses an id already used by another person's region with 409 duplicate", async () => {
    const taken = seed(OTHER_GUEST);
    await expectError(await add('guest', photoId, { id: taken, ...RECT }), 409, 'duplicate');
    expect(store.messages).toEqual([]);
  });

  it('refuses an id already used on another photo with 409 duplicate', async () => {
    const otherPhoto = randomUUID();
    store.photos.set(otherPhoto, { eventId, processed: true, deleted: false });
    const taken = seed(GUEST, otherPhoto);
    await expectError(await add('guest', photoId, { id: taken, ...RECT }), 409, 'duplicate');
  });
});

describe('GET /media/:mediaId/blur-regions', () => {
  it('answers an unknown photo with 404', async () => {
    await expectError(await list('guest', randomUUID()), 404, 'not_found');
  });

  it('lists only the Guest’s own regions', async () => {
    const mine = seed(GUEST);
    seed(OTHER_GUEST);
    seed(ADMIN);
    const regions = await regionsOf(await list('guest'));
    expect(regions.map((r) => r.id)).toEqual([mine]);
  });

  it('lists every region for the Admin, with who drew each', async () => {
    seed(GUEST);
    seed(OTHER_GUEST);
    const regions = await regionsOf(await list('admin'));
    expect(regions.map((r) => r.drawnBy)).toEqual([
      { userId: GUEST, fullName: 'Guest Person' },
      { userId: OTHER_GUEST, fullName: 'Other Guest' },
    ]);
  });

  it('sends no message', async () => {
    seed(GUEST);
    await regionsOf(await list('admin'));
    expect(store.messages).toEqual([]);
  });
});

describe('DELETE /blur-regions/:regionId', () => {
  it('answers an unknown region, one already removed included, with 404', async () => {
    await expectError(await remove('guest', randomUUID()), 404, 'not_found');
    const id = seed(GUEST);
    await regionsOf(await remove('guest', id));
    await expectError(await remove('guest', id), 404, 'not_found');
    expect(store.messages).toHaveLength(1);
  });

  it('refuses a path id that is not a uuid with 400', async () => {
    await expectError(await remove('guest', 'not-a-uuid'), 400, 'invalid_request');
  });

  it("refuses a Guest removing another person's region with 403 not_drawer", async () => {
    const theirs = seed(OTHER_GUEST);
    await expectError(await remove('guest', theirs), 403, 'not_drawer');
    expect(store.regions.map((r) => r.id)).toEqual([theirs]);
    expect(store.messages).toEqual([]);
  });

  it('lets a Guest remove their own, answering their list and sending one message', async () => {
    const mine = seed(GUEST);
    const kept = seed(GUEST);
    seed(OTHER_GUEST);
    const regions = await regionsOf(await remove('guest', mine));
    expect(regions.map((r) => r.id)).toEqual([kept]);
    expect(store.messages).toEqual([photoId]);
  });

  it("lets the Admin remove anyone's region, a departed drawer's included", async () => {
    const theirs = seed(REMOVED);
    const other = seed(GUEST);
    const regions = await regionsOf(await remove('admin', theirs));
    expect(regions.map((r) => r.id)).toEqual([other]);
    expect(store.messages).toEqual([photoId]);
  });
});
