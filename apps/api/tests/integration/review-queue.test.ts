// Admin Review Queue endpoints (spec §2.5.7, arch:photo_flag, arch:manual_blur_region, D-181)
// and integration with POST /events/{eventId}/media/images (root invariants 1, 2, 3, 4, 6, 12, 13).
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  ErrorResponse,
  KeepBlurRegionResponse,
  KeepPhotoFlagsResponse,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsResponse,
  MAX_REVIEW_QUEUE_PAGE,
  MediaImagesResponse,
} from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import type { MediaImagesRecord, MediaImagesStore } from '../../src/services/media-images';
import type {
  FlaggedPhotoRow,
  FlaggedPhotosPage,
  KeepBlurRegionResult,
  KeepPhotoFlagsResult,
  ReviewBlurRegionRow,
  ReviewBlurRegionsPage,
  ReviewQueueStore,
} from '../../src/services/review-queue';
import {
  encodeFlaggedPhotosCursor,
  encodeReviewBlurRegionsCursor,
} from '../../src/services/review-queue';
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
  [GUEST, 'Guest One'],
  [OTHER_GUEST, 'Guest Two'],
  [PHOTOGRAPHER, 'Photographer Person'],
  [REMOVED, 'Departed Drawer'],
]);

const verifyToken: VerifyToken = (token) => {
  const id = tokens.get(token);
  return Promise.resolve(id === undefined ? null : { id });
};

const NOT_MEMBERS = [
  ['a pending member', 'pending'],
  ['a blocked member', 'blocked'],
  ['a removed member', 'removed'],
  ['someone with no membership', 'outsider'],
  ["another event's Admin", 'other-event-admin'],
] as const;

interface FakeEvent {
  deleted: boolean;
  albumOpen: boolean;
  members: Map<string, { role: MembershipRole; status: MembershipStatus }>;
}

class FakeEvents implements EventStore {
  readonly events = new Map<string, FakeEvent>();

  create = () => Promise.reject(new Error('not used here'));
  listForMember = () => Promise.reject(new Error('not used here'));
  listJoinRequests = () => Promise.reject(new Error('not used here'));
  findForCaller = () => Promise.reject(new Error('not used here'));
  setCover = () => Promise.reject(new Error('not used here'));
  settings = () => Promise.reject(new Error('not used here'));
  updateSettings = () => Promise.reject(new Error('not used here'));
  albumStatus = () => Promise.reject(new Error('not used here'));
  setAlbum = () => Promise.reject(new Error('not used here'));

  findAccess(eventId: string, userId: string): Promise<MemberAccess | null> {
    const event = this.events.get(eventId);
    if (event === undefined) return Promise.resolve(null);
    return Promise.resolve({
      deleted: event.deleted,
      albumOpen: event.albumOpen,
      membership: event.members.get(userId) ?? null,
    });
  }
}

interface FakePhoto {
  id: string;
  eventId: string;
  subEventId: string;
  subEventName: string;
  capturedAt: string;
  uploaderUserId: string;
  uploaderRole: MembershipRole;
  width: number | null;
  height: number | null;
  variantVersion: number;
  processed: boolean;
  deleted: boolean;
}

interface FakeFlag {
  mediaId: string;
  flaggedByUserId: string;
  state: 'open' | 'kept';
  createdAt: string;
}

interface FakeRegion {
  id: string;
  mediaId: string;
  drawnByUserId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: 'open' | 'kept';
  createdAt: string;
}

class FakeReviewQueueStore implements ReviewQueueStore {
  constructor(private readonly events: FakeEvents) {}

  readonly photos = new Map<string, FakePhoto>();
  flags: FakeFlag[] = [];
  regions: FakeRegion[] = [];

  private isLivePublished(photo: FakePhoto | undefined): photo is FakePhoto {
    if (photo === undefined || !photo.processed || photo.deleted) return false;
    const event = this.events.events.get(photo.eventId);
    return event !== undefined && !event.deleted;
  }

  listFlags(
    eventId: string,
    options: { cursor?: { latestFlaggedAt: string; mediaId: string }; limit: number },
  ): Promise<FlaggedPhotosPage> {
    const grouped = new Map<string, { photo: FakePhoto; count: number; latest: string }>();
    for (const flag of this.flags) {
      if (flag.state !== 'open') continue;
      const photo = this.photos.get(flag.mediaId);
      if (!this.isLivePublished(photo) || photo.eventId !== eventId) continue;
      const current = grouped.get(photo.id);
      if (current === undefined) {
        grouped.set(photo.id, { photo, count: 1, latest: flag.createdAt });
      } else {
        current.count += 1;
        if (flag.createdAt > current.latest) current.latest = flag.createdAt;
      }
    }

    const sorted: FlaggedPhotoRow[] = [...grouped.values()]
      .sort((a, b) => {
        if (a.latest !== b.latest) return a.latest > b.latest ? -1 : 1;
        return a.photo.id > b.photo.id ? -1 : a.photo.id < b.photo.id ? 1 : 0;
      })
      .map(({ photo, count, latest }) => ({
        media: {
          id: photo.id,
          subEventId: photo.subEventId,
          capturedAt: photo.capturedAt,
          uploaderUserId: photo.uploaderUserId,
          uploaderName: NAMES.get(photo.uploaderUserId) ?? 'Someone',
          uploaderRole: photo.uploaderRole,
          width: photo.width,
          height: photo.height,
          variantVersion: photo.variantVersion,
        },
        subEventName: photo.subEventName,
        flagCount: count,
        latestFlaggedAt: latest,
      }));

    const after = options.cursor;
    const filtered =
      after === undefined
        ? sorted
        : sorted.filter(
            (r) =>
              r.latestFlaggedAt < after.latestFlaggedAt ||
              (r.latestFlaggedAt === after.latestFlaggedAt && r.media.id < after.mediaId),
          );

    return Promise.resolve({
      openCount: sorted.length,
      rows: filtered.slice(0, options.limit + 1),
    });
  }

  keepPhotoFlags(mediaId: string, userId: string): Promise<KeepPhotoFlagsResult> {
    const photo = this.photos.get(mediaId);
    if (!this.isLivePublished(photo)) return Promise.resolve({ outcome: 'not_found' });
    const membership = this.events.events.get(photo.eventId)?.members.get(userId);
    if (membership?.status !== 'active') return Promise.resolve({ outcome: 'not_member' });
    if (membership.role !== 'admin') return Promise.resolve({ outcome: 'wrong_role' });

    let keptCount = 0;
    for (const flag of this.flags) {
      if (flag.mediaId === mediaId && flag.state === 'open') {
        flag.state = 'kept';
        keptCount += 1;
      }
    }
    return Promise.resolve({ outcome: 'kept', keptCount });
  }

  listBlurRegions(
    eventId: string,
    options: { cursor?: { createdAt: string; regionId: string }; limit: number },
  ): Promise<ReviewBlurRegionsPage> {
    const open: ReviewBlurRegionRow[] = this.regions
      .filter((r) => {
        if (r.state !== 'open') return false;
        const photo = this.photos.get(r.mediaId);
        return this.isLivePublished(photo) && photo.eventId === eventId;
      })
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
        return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
      })
      .map((r) => {
        const photo = this.photos.get(r.mediaId)!;
        return {
          region: {
            id: r.id,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            drawnBy: {
              userId: r.drawnByUserId,
              fullName: NAMES.get(r.drawnByUserId) ?? 'Someone',
            },
            createdAt: r.createdAt,
          },
          media: {
            id: photo.id,
            width: photo.width,
            height: photo.height,
            variantVersion: photo.variantVersion,
          },
        };
      });

    const after = options.cursor;
    const filtered =
      after === undefined
        ? open
        : open.filter(
            (r) =>
              r.region.createdAt < after.createdAt ||
              (r.region.createdAt === after.createdAt && r.region.id < after.regionId),
          );

    return Promise.resolve({
      openCount: open.length,
      rows: filtered.slice(0, options.limit + 1),
    });
  }

  keepBlurRegion(regionId: string, userId: string): Promise<KeepBlurRegionResult> {
    const region = this.regions.find((r) => r.id === regionId);
    if (region === undefined) return Promise.resolve({ outcome: 'not_found' });
    const photo = this.photos.get(region.mediaId);
    if (!this.isLivePublished(photo)) return Promise.resolve({ outcome: 'not_found' });
    const membership = this.events.events.get(photo.eventId)?.members.get(userId);
    if (membership?.status !== 'active') return Promise.resolve({ outcome: 'not_member' });
    if (membership.role !== 'admin') return Promise.resolve({ outcome: 'wrong_role' });

    region.state = 'kept';
    return Promise.resolve({ outcome: 'kept' });
  }
}

class FakeMediaImagesStore implements MediaImagesStore {
  records: Omit<MediaImagesRecord, 'variantKey' | 'variantThumbKey'>[] = [];
  subjects: { mediaId: string; userId: string; variantKey: string; variantThumbKey: string }[] = [];

  findForServing(
    eventId: string,
    mediaIds: string[],
    userId: string,
  ): Promise<MediaImagesRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => r.eventId === eventId && mediaIds.includes(r.id))
        .map((r) => {
          const own = this.subjects.find((s) => s.mediaId === r.id && s.userId === userId);
          return {
            ...r,
            variantKey: own?.variantKey ?? null,
            variantThumbKey: own?.variantThumbKey ?? null,
          };
        }),
    );
  }
}

let events: FakeEvents;
let store: FakeReviewQueueStore;
let mediaImages: FakeMediaImagesStore;
let app: RunningApp;
let eventId: string;
let otherEventId: string;
let subEventId: string;
let photoId: string;
let regionId: string;
const signedGets: string[] = [];

beforeAll(async () => {
  events = new FakeEvents();
  store = new FakeReviewQueueStore(events);
  mediaImages = new FakeMediaImagesStore();
  app = await startApp(
    testDeps({
      verifyToken,
      events,
      reviewQueue: store,
      mediaImages,
      presignGet: (key) => {
        signedGets.push(key);
        return Promise.resolve(`https://r2.test/${key}?signed=true`);
      },
    }),
  );
});

afterAll(async () => {
  await app.close();
});

function makePhoto(overrides: Partial<FakePhoto> = {}): FakePhoto {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    eventId,
    subEventId,
    subEventName: 'Mehndi',
    capturedAt: '2026-12-10T12:00:00.123456+00:00',
    uploaderUserId: GUEST,
    uploaderRole: 'guest',
    width: 1200,
    height: 900,
    variantVersion: 2,
    processed: true,
    deleted: false,
    ...overrides,
  };
}

beforeEach(() => {
  events.events.clear();
  store.photos.clear();
  store.flags = [];
  store.regions = [];
  mediaImages.records = [];
  mediaImages.subjects = [];
  signedGets.length = 0;

  eventId = randomUUID();
  otherEventId = randomUUID();
  subEventId = randomUUID();
  photoId = randomUUID();
  regionId = randomUUID();

  events.events.set(eventId, {
    deleted: false,
    albumOpen: true,
    members: new Map([
      [ADMIN, { role: 'admin', status: 'active' }],
      [GUEST, { role: 'guest', status: 'active' }],
      [OTHER_GUEST, { role: 'guest', status: 'active' }],
      [PHOTOGRAPHER, { role: 'photographer', status: 'active' }],
      [PENDING, { role: 'guest', status: 'pending' }],
      [BLOCKED, { role: 'guest', status: 'blocked' }],
      [REMOVED, { role: 'guest', status: 'removed' }],
    ]),
  });
  events.events.set(otherEventId, {
    deleted: false,
    albumOpen: true,
    members: new Map([[OTHER_EVENT_ADMIN, { role: 'admin', status: 'active' }]]),
  });

  store.photos.set(photoId, makePhoto({ id: photoId }));
  store.flags.push({
    mediaId: photoId,
    flaggedByUserId: GUEST,
    state: 'open',
    createdAt: '2026-12-10T14:00:00.123456+00:00',
  });
  store.regions.push({
    id: regionId,
    mediaId: photoId,
    drawnByUserId: GUEST,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.25,
    state: 'open',
    createdAt: '2026-12-10T14:05:00.123456+00:00',
  });
});

function call(method: 'GET' | 'POST', path: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${app.baseUrl}${path}`, { method, headers });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = ErrorResponse.parse(await res.json());
  expect(body.error.code).toBe(code);
}

const ALL_ENDPOINTS = [
  [
    'GET /review-queue/flags',
    (t: string | null) => call('GET', `/events/${eventId}/review-queue/flags`, t),
  ],
  ['POST /flags/keep', (t: string | null) => call('POST', `/media/${photoId}/flags/keep`, t)],
  [
    'GET /review-queue/blur-regions',
    (t: string | null) => call('GET', `/events/${eventId}/review-queue/blur-regions`, t),
  ],
  [
    'POST /blur-regions/keep',
    (t: string | null) => call('POST', `/blur-regions/${regionId}/keep`, t),
  ],
] as const;

describe.each(ALL_ENDPOINTS)('%s refusals', (_name, send) => {
  it('refuses unauthenticated callers with 401 no_session', async () => {
    await expectError(await send(null), 401, 'no_session');
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      await expectError(await send(token), 403, 'not_member');
    });
  }

  it.each([
    ['a Guest', 'guest'],
    ['a Photographer', 'photographer'],
  ] as const)('refuses %s with 403 wrong_role', async (_who, token) => {
    await expectError(await send(token), 403, 'wrong_role');
  });

  it('refuses a soft-deleted event with 404 not_found', async () => {
    events.events.get(eventId)!.deleted = true;
    await expectError(await send('admin'), 404, 'not_found');
  });
});

describe('400 invalid_request and 404 not_found checks', () => {
  it('refuses non-uuid path parameters with 400 invalid_request', async () => {
    await expectError(
      await call('GET', '/events/not-a-uuid/review-queue/flags', 'admin'),
      400,
      'invalid_request',
    );
    await expectError(
      await call('POST', '/media/not-a-uuid/flags/keep', 'admin'),
      400,
      'invalid_request',
    );
    await expectError(
      await call('GET', '/events/not-a-uuid/review-queue/blur-regions', 'admin'),
      400,
      'invalid_request',
    );
    await expectError(
      await call('POST', '/blur-regions/not-a-uuid/keep', 'admin'),
      400,
      'invalid_request',
    );
  });

  it('refuses unknown query keys and invalid, cross-event, or cross-endpoint cursors with 400', async () => {
    await expectError(
      await call('GET', `/events/${eventId}/review-queue/flags?extra=1`, 'admin'),
      400,
      'invalid_request',
    );
    await expectError(
      await call('GET', `/events/${eventId}/review-queue/blur-regions?extra=1`, 'admin'),
      400,
      'invalid_request',
    );

    const otherEventFlagsCursor = encodeFlaggedPhotosCursor({
      kind: 'flags',
      eventId: otherEventId,
      latestFlaggedAt: '2026-12-10T14:00:00.123456+00:00',
      mediaId: photoId,
    });
    const regionsCursor = encodeReviewBlurRegionsCursor({
      kind: 'blur-regions',
      eventId,
      createdAt: '2026-12-10T14:00:00.123456+00:00',
      regionId,
    });
    const flagsCursor = encodeFlaggedPhotosCursor({
      kind: 'flags',
      eventId,
      latestFlaggedAt: '2026-12-10T14:00:00.123456+00:00',
      mediaId: photoId,
    });

    for (const bad of ['tampered', otherEventFlagsCursor, regionsCursor]) {
      await expectError(
        await call(
          'GET',
          `/events/${eventId}/review-queue/flags?cursor=${encodeURIComponent(bad)}`,
          'admin',
        ),
        400,
        'invalid_request',
      );
    }
    for (const bad of ['tampered', flagsCursor]) {
      await expectError(
        await call(
          'GET',
          `/events/${eventId}/review-queue/blur-regions?cursor=${encodeURIComponent(bad)}`,
          'admin',
        ),
        400,
        'invalid_request',
      );
    }
  });

  it('refuses unknown event, unknown/unprocessed/deleted photo, or removed region with 404', async () => {
    const unknown = randomUUID();
    await expectError(
      await call('GET', `/events/${unknown}/review-queue/flags`, 'admin'),
      404,
      'not_found',
    );
    await expectError(
      await call('GET', `/events/${unknown}/review-queue/blur-regions`, 'admin'),
      404,
      'not_found',
    );
    await expectError(
      await call('POST', `/media/${unknown}/flags/keep`, 'admin'),
      404,
      'not_found',
    );
    await expectError(
      await call('POST', `/blur-regions/${unknown}/keep`, 'admin'),
      404,
      'not_found',
    );

    store.photos.get(photoId)!.processed = false;
    await expectError(
      await call('POST', `/media/${photoId}/flags/keep`, 'admin'),
      404,
      'not_found',
    );
    await expectError(
      await call('POST', `/blur-regions/${regionId}/keep`, 'admin'),
      404,
      'not_found',
    );

    store.photos.get(photoId)!.processed = true;
    store.photos.get(photoId)!.deleted = true;
    await expectError(
      await call('POST', `/media/${photoId}/flags/keep`, 'admin'),
      404,
      'not_found',
    );
    await expectError(
      await call('POST', `/blur-regions/${regionId}/keep`, 'admin'),
      404,
      'not_found',
    );
  });
});

describe('GET /events/:eventId/review-queue/flags and POST /media/:mediaId/flags/keep', () => {
  it('collapses multiple open flags on one photo without naming flaggers and drops kept/deleted/unprocessed photos', async () => {
    store.flags.push(
      {
        mediaId: photoId,
        flaggedByUserId: OTHER_GUEST,
        state: 'open',
        createdAt: '2026-12-10T14:10:00.654321+00:00',
      },
      // Kept flag on the same photo does not add to open flagCount.
      {
        mediaId: photoId,
        flaggedByUserId: PHOTOGRAPHER,
        state: 'kept',
        createdAt: '2026-12-10T14:20:00.000000+00:00',
      },
    );

    const unpublished = makePhoto({ processed: false });
    const deleted = makePhoto({ deleted: true });
    const keptOnly = makePhoto();
    store.photos.set(unpublished.id, unpublished);
    store.photos.set(deleted.id, deleted);
    store.photos.set(keptOnly.id, keptOnly);
    store.flags.push(
      {
        mediaId: unpublished.id,
        flaggedByUserId: GUEST,
        state: 'open',
        createdAt: '2026-12-10T14:30:00.000000+00:00',
      },
      {
        mediaId: deleted.id,
        flaggedByUserId: GUEST,
        state: 'open',
        createdAt: '2026-12-10T14:30:00.000000+00:00',
      },
      {
        mediaId: keptOnly.id,
        flaggedByUserId: GUEST,
        state: 'kept',
        createdAt: '2026-12-10T14:30:00.000000+00:00',
      },
    );

    events.events.get(eventId)!.albumOpen = false;
    const res = await call('GET', `/events/${eventId}/review-queue/flags`, 'admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const raw = await res.text();
    expect(raw).not.toContain(OTHER_GUEST);
    expect(raw).not.toContain('Guest Two');
    expect(raw).not.toContain('http://');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('upload.jpg');
    expect(raw).not.toContain('upload_thumb');
    expect(raw).not.toContain('uploadKey');
    expect(raw).not.toContain('public_v');
    expect(raw).not.toContain('publicKey');

    const body = ListFlaggedPhotosResponse.parse(JSON.parse(raw));
    expect(body).toEqual({
      photos: [
        {
          media: {
            id: photoId,
            subEventId,
            capturedAt: '2026-12-10T12:00:00.123Z',
            uploaderUserId: GUEST,
            uploaderName: 'Guest One',
            uploaderRole: 'guest',
            width: 1200,
            height: 900,
            variantVersion: 2,
          },
          subEventName: 'Mehndi',
          flagCount: 2,
          latestFlaggedAt: '2026-12-10T14:10:00.654Z',
        },
      ],
      openCount: 1,
      nextCursor: null,
    });

    const keepRes = await call('POST', `/media/${photoId}/flags/keep`, 'admin');
    expect(keepRes.status).toBe(200);
    expect(keepRes.headers.get('cache-control')).toBe('no-store');
    expect(KeepPhotoFlagsResponse.parse(await keepRes.json())).toEqual({
      mediaId: photoId,
      keptCount: 2,
    });

    const repeatKeep = await call('POST', `/media/${photoId}/flags/keep`, 'admin');
    expect(repeatKeep.status).toBe(200);
    expect(KeepPhotoFlagsResponse.parse(await repeatKeep.json())).toEqual({
      mediaId: photoId,
      keptCount: 0,
    });

    const afterKeep = ListFlaggedPhotosResponse.parse(
      await (await call('GET', `/events/${eventId}/review-queue/flags`, 'admin')).json(),
    );
    expect(afterKeep).toEqual({ photos: [], openCount: 0, nextCursor: null });
  });

  it('paginates 51+ flagged photos at 50 per page with constant openCount and no duplicates', async () => {
    store.flags = [];
    const baseMs = Date.parse('2026-12-10T10:00:00.000Z');
    for (let i = 0; i < MAX_REVIEW_QUEUE_PAGE + 5; i += 1) {
      const p = makePhoto({ uploaderUserId: REMOVED });
      store.photos.set(p.id, p);
      store.flags.push({
        mediaId: p.id,
        flaggedByUserId: GUEST,
        state: 'open',
        createdAt: new Date(baseMs + i * 1000).toISOString().replace('Z', '+00:00'),
      });
    }

    const page1 = ListFlaggedPhotosResponse.parse(
      await (await call('GET', `/events/${eventId}/review-queue/flags`, 'admin')).json(),
    );
    expect(page1.photos).toHaveLength(MAX_REVIEW_QUEUE_PAGE);
    expect(page1.openCount).toBe(MAX_REVIEW_QUEUE_PAGE + 5);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.photos[0]?.media.uploaderName).toBe('Departed Drawer');

    const page2 = ListFlaggedPhotosResponse.parse(
      await (
        await call(
          'GET',
          `/events/${eventId}/review-queue/flags?cursor=${encodeURIComponent(page1.nextCursor!)}`,
          'admin',
        )
      ).json(),
    );
    expect(page2.photos).toHaveLength(5);
    expect(page2.openCount).toBe(MAX_REVIEW_QUEUE_PAGE + 5);
    expect(page2.nextCursor).toBeNull();

    const ids = [...page1.photos, ...page2.photos].map((p) => p.media.id);
    expect(new Set(ids).size).toBe(MAX_REVIEW_QUEUE_PAGE + 5);
  });
});

describe('GET /events/:eventId/review-queue/blur-regions and POST /blur-regions/:regionId/keep', () => {
  it('lists open regions only, preserves departed drawer names, keeps idempotently, and emits no URLs/keys', async () => {
    const adminKept = randomUUID();
    const removedDrawerOpen = randomUUID();
    const unpublishedPhoto = makePhoto({ processed: false });
    const deletedPhoto = makePhoto({ deleted: true });
    store.photos.set(unpublishedPhoto.id, unpublishedPhoto);
    store.photos.set(deletedPhoto.id, deletedPhoto);

    store.regions.push(
      {
        id: adminKept,
        mediaId: photoId,
        drawnByUserId: ADMIN,
        x: 0.2,
        y: 0.2,
        width: 0.2,
        height: 0.2,
        state: 'kept',
        createdAt: '2026-12-10T14:15:00.000000+00:00',
      },
      {
        id: removedDrawerOpen,
        mediaId: photoId,
        drawnByUserId: REMOVED,
        x: 0.3,
        y: 0.3,
        width: 0.2,
        height: 0.2,
        state: 'open',
        createdAt: '2026-12-10T14:20:00.123456+00:00',
      },
      {
        id: randomUUID(),
        mediaId: unpublishedPhoto.id,
        drawnByUserId: GUEST,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
        state: 'open',
        createdAt: '2026-12-10T14:25:00.000000+00:00',
      },
      {
        id: randomUUID(),
        mediaId: deletedPhoto.id,
        drawnByUserId: GUEST,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
        state: 'open',
        createdAt: '2026-12-10T14:26:00.000000+00:00',
      },
    );

    events.events.get(eventId)!.albumOpen = false;
    const res = await call('GET', `/events/${eventId}/review-queue/blur-regions`, 'admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const raw = await res.text();
    expect(raw).not.toContain('http://');
    expect(raw).not.toContain('https://');
    expect(raw).not.toContain('upload.jpg');
    expect(raw).not.toContain('upload_thumb');
    expect(raw).not.toContain('uploadKey');
    expect(raw).not.toContain('public_v');
    expect(raw).not.toContain('publicKey');

    const body = ListReviewBlurRegionsResponse.parse(JSON.parse(raw));
    expect(body.openCount).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(body.regions.map((r) => r.region.id)).toEqual([removedDrawerOpen, regionId]);
    expect(body.regions[0]?.region.drawnBy).toEqual({
      userId: REMOVED,
      fullName: 'Departed Drawer',
    });

    const keepRes = await call('POST', `/blur-regions/${removedDrawerOpen}/keep`, 'admin');
    expect(keepRes.status).toBe(200);
    expect(keepRes.headers.get('cache-control')).toBe('no-store');
    expect(KeepBlurRegionResponse.parse(await keepRes.json())).toEqual({
      regionId: removedDrawerOpen,
      state: 'kept',
    });

    // Idempotent repeat Keep.
    const repeatKeep = await call('POST', `/blur-regions/${removedDrawerOpen}/keep`, 'admin');
    expect(repeatKeep.status).toBe(200);
    expect(KeepBlurRegionResponse.parse(await repeatKeep.json())).toEqual({
      regionId: removedDrawerOpen,
      state: 'kept',
    });

    const after = ListReviewBlurRegionsResponse.parse(
      await (await call('GET', `/events/${eventId}/review-queue/blur-regions`, 'admin')).json(),
    );
    expect(after.openCount).toBe(1);
    expect(after.regions.map((r) => r.region.id)).toEqual([regionId]);
  });

  it('paginates 51+ open blur regions at 50 per page with constant openCount', async () => {
    store.regions = [];
    const baseMs = Date.parse('2026-12-10T10:00:00.000Z');
    for (let i = 0; i < MAX_REVIEW_QUEUE_PAGE + 4; i += 1) {
      store.regions.push({
        id: randomUUID(),
        mediaId: photoId,
        drawnByUserId: GUEST,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
        state: 'open',
        createdAt: new Date(baseMs + i * 1000).toISOString().replace('Z', '+00:00'),
      });
    }

    const page1 = ListReviewBlurRegionsResponse.parse(
      await (await call('GET', `/events/${eventId}/review-queue/blur-regions`, 'admin')).json(),
    );
    expect(page1.regions).toHaveLength(MAX_REVIEW_QUEUE_PAGE);
    expect(page1.openCount).toBe(MAX_REVIEW_QUEUE_PAGE + 4);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = ListReviewBlurRegionsResponse.parse(
      await (
        await call(
          'GET',
          `/events/${eventId}/review-queue/blur-regions?cursor=${encodeURIComponent(page1.nextCursor!)}`,
          'admin',
        )
      ).json(),
    );
    expect(page2.regions).toHaveLength(4);
    expect(page2.openCount).toBe(MAX_REVIEW_QUEUE_PAGE + 4);
    expect(page2.nextCursor).toBeNull();

    const ids = [...page1.regions, ...page2.regions].map((r) => r.region.id);
    expect(new Set(ids).size).toBe(MAX_REVIEW_QUEUE_PAGE + 4);
  });
});

describe('Review Queue image serving privacy (root invariants 2, 3, 4, 6)', () => {
  it('gives Admin the public blurred file for another DNP subject and isOwnVariant only when Admin is the subject', async () => {
    const guestSubjectPhoto = photoId;
    const adminSubjectPhoto = randomUUID();
    store.photos.set(adminSubjectPhoto, makePhoto({ id: adminSubjectPhoto, variantVersion: 3 }));
    store.flags.push({
      mediaId: adminSubjectPhoto,
      flaggedByUserId: GUEST,
      state: 'open',
      createdAt: '2026-12-10T14:20:00.000000+00:00',
    });

    const guestVariantKey = `${guestSubjectPhoto}/guest-subj_v2.jpg`;
    const guestVariantThumbKey = `${guestSubjectPhoto}/guest-subj_thumb_v2.webp`;
    const adminVariantKey = `${adminSubjectPhoto}/admin-subj_v3.jpg`;
    const adminVariantThumbKey = `${adminSubjectPhoto}/admin-subj_thumb_v3.webp`;

    mediaImages.records = [
      {
        id: guestSubjectPhoto,
        eventId,
        uploaderUserId: GUEST,
        uploadKey: `${guestSubjectPhoto}/upload.jpg`,
        uploadThumbKey: `${guestSubjectPhoto}/upload_thumb.webp`,
        publicKey: `${guestSubjectPhoto}/public_v2.jpg`,
        publicThumbKey: `${guestSubjectPhoto}/public_thumb_v2.webp`,
        variantVersion: 2,
        processedAt: '2026-12-10T12:05:00.000Z',
        deletedAt: null,
      },
      {
        id: adminSubjectPhoto,
        eventId,
        uploaderUserId: GUEST,
        uploadKey: `${adminSubjectPhoto}/upload.jpg`,
        uploadThumbKey: `${adminSubjectPhoto}/upload_thumb.webp`,
        publicKey: `${adminSubjectPhoto}/public_v3.jpg`,
        publicThumbKey: `${adminSubjectPhoto}/public_thumb_v3.webp`,
        variantVersion: 3,
        processedAt: '2026-12-10T12:05:00.000Z',
        deletedAt: null,
      },
    ];
    mediaImages.subjects = [
      {
        mediaId: guestSubjectPhoto,
        userId: OTHER_GUEST,
        variantKey: guestVariantKey,
        variantThumbKey: guestVariantThumbKey,
      },
      {
        mediaId: adminSubjectPhoto,
        userId: ADMIN,
        variantKey: adminVariantKey,
        variantThumbKey: adminVariantThumbKey,
      },
    ];

    const listRes = ListFlaggedPhotosResponse.parse(
      await (await call('GET', `/events/${eventId}/review-queue/flags`, 'admin')).json(),
    );
    const ids = listRes.photos.map((p) => p.media.id);
    expect(ids.sort()).toEqual([guestSubjectPhoto, adminSubjectPhoto].sort());

    const imgRes = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaIds: ids, size: 'thumbnail' }),
    });
    expect(imgRes.status).toBe(200);
    const raw = await imgRes.text();
    expect(raw).not.toContain(guestVariantKey);
    expect(raw).not.toContain(guestVariantThumbKey);

    const parsed = MediaImagesResponse.parse(JSON.parse(raw));
    expect(parsed.images[guestSubjectPhoto]).toEqual({
      url: `https://r2.test/${guestSubjectPhoto}/public_thumb_v2.webp?signed=true`,
      cacheKey: `${guestSubjectPhoto}/public_thumb_v2.webp#v2`,
      isOwnVariant: false,
    });
    expect(parsed.images[adminSubjectPhoto]).toEqual({
      url: `https://r2.test/${adminVariantThumbKey}?signed=true`,
      cacheKey: `${adminVariantThumbKey}#v3`,
      isOwnVariant: true,
    });
  });
});
