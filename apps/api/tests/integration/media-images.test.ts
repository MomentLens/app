// POST /events/{eventId}/media/images (D-57, D-60, D-86, D-148, arch §1, arch §3, hb §5.2, hb §11.3).
// The image-serving authorization check and presigned URL retrieval.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { pino } from 'pino';

import { ErrorResponse, MediaImagesResponse } from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import type { MediaImagesRecord, MediaImagesStore } from '../../src/services/media-images';
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

const tokens = new Map([
  ['token-admin', ADMIN],
  ['token-guest', GUEST],
  ['token-other-guest', OTHER_GUEST],
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

const NOT_MEMBERS = [
  ['a pending member', 'token-pending'],
  ['a blocked member', 'token-blocked'],
  ['a removed member', 'token-removed'],
  ['someone with no membership', 'token-outsider'],
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

class FakeMediaImagesStore implements MediaImagesStore {
  records: MediaImagesRecord[] = [];

  findForServing(eventId: string, mediaIds: string[]): Promise<MediaImagesRecord[]> {
    return Promise.resolve(
      this.records.filter((r) => r.eventId === eventId && mediaIds.includes(r.id)),
    );
  }
}

const logger = pino({ level: 'silent' });
let events: FakeEvents;
let mediaImagesStore: FakeMediaImagesStore;
let app: RunningApp;
let eventId: string;
let otherEventId: string;

const signedGets: string[] = [];
const mockPresignGet = (key: string): Promise<string> => {
  signedGets.push(key);
  return Promise.resolve(`https://r2.test/${key}?signed=true`);
};

beforeAll(async () => {
  events = new FakeEvents();
  mediaImagesStore = new FakeMediaImagesStore();
  app = await startApp(
    testDeps({
      logger,
      verifyToken,
      events,
      mediaImages: mediaImagesStore,
      presignGet: mockPresignGet,
    }),
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  events.events.clear();
  mediaImagesStore.records = [];
  signedGets.length = 0;

  eventId = randomUUID();
  otherEventId = randomUUID();

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
});

describe('POST /events/:eventId/media/images', () => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaIds: [randomUUID()], size: 'full' }),
    });
    expect(res.status).toBe(401);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('no_session');
  });

  it('refuses an unknown event with 404 not_found', async () => {
    const unknownId = randomUUID();
    const res = await fetch(`${app.baseUrl}/events/${unknownId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds: [randomUUID()], size: 'full' }),
    });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  it('refuses a deleted event with 404 not_found', async () => {
    events.events.get(eventId)!.deleted = true;
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds: [randomUUID()], size: 'full' }),
    });
    expect(res.status).toBe(404);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('not_found');
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mediaIds: [randomUUID()], size: 'full' }),
      });
      expect(res.status).toBe(403);
      const body = ErrorResponse.parse(await res.json());
      expect(body.error.code).toBe('not_member');
    });
  }

  it('refuses 51 media ids with 400 invalid_request', async () => {
    const mediaIds = Array.from({ length: 51 }, () => randomUUID());
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds, size: 'full' }),
    });
    expect(res.status).toBe(400);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('invalid_request');
  });

  it('refuses empty media ids with 400 invalid_request', async () => {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds: [], size: 'full' }),
    });
    expect(res.status).toBe(400);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('invalid_request');
  });

  it('refuses duplicate media ids with 400 invalid_request', async () => {
    const id = randomUUID();
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds: [id, id], size: 'full' }),
    });
    expect(res.status).toBe(400);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error.code).toBe('invalid_request');
  });

  it('signs public_key when differing from upload_key, returns versioned cache key, and never returns upload keys', async () => {
    const mediaId = randomUUID();
    const uploadKey = `${mediaId}/upload.jpg`;
    const uploadThumbKey = `${mediaId}/upload_thumb.webp`;
    const publicKey = `${mediaId}/public_v1.jpg`;
    const publicThumbKey = `${mediaId}/public_thumb_v1.webp`;

    mediaImagesStore.records = [
      {
        id: mediaId,
        eventId,
        uploaderUserId: GUEST,
        uploadKey,
        uploadThumbKey,
        publicKey,
        publicThumbKey,
        variantVersion: 1,
        processedAt: '2026-10-06T10:00:00.000Z',
        deletedAt: null,
      },
    ];

    // Request full size
    const resFull = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds: [mediaId], size: 'full' }),
    });
    expect(resFull.status).toBe(200);
    const bodyFull = MediaImagesResponse.parse(await resFull.json());
    expect(bodyFull.images[mediaId]).toBeDefined();
    expect(bodyFull.images[mediaId]?.url).toBe(`https://r2.test/${publicKey}?signed=true`);
    expect(bodyFull.images[mediaId]?.cacheKey).toBe(`${publicKey}#v1`);

    // Verify neither upload key appears in response
    const rawText = JSON.stringify(bodyFull);
    expect(rawText.includes(uploadKey)).toBe(false);
    expect(rawText.includes(uploadThumbKey)).toBe(false);

    // Request thumbnail size
    const resThumb = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mediaIds: [mediaId], size: 'thumbnail' }),
    });
    expect(resThumb.status).toBe(200);
    const bodyThumb = MediaImagesResponse.parse(await resThumb.json());
    expect(bodyThumb.images[mediaId]).toBeDefined();
    expect(bodyThumb.images[mediaId]?.url).toBe(`https://r2.test/${publicThumbKey}?signed=true`);
    expect(bodyThumb.images[mediaId]?.cacheKey).toBe(`${publicThumbKey}#v1`);
  });

  it('omits another events row, unprocessed rows, and deleted rows', async () => {
    const publishedId = randomUUID();
    const otherEventRowId = randomUUID();
    const unprocessedId = randomUUID();
    const deletedId = randomUUID();

    mediaImagesStore.records = [
      {
        id: publishedId,
        eventId,
        uploaderUserId: GUEST,
        uploadKey: `${publishedId}/upload.jpg`,
        uploadThumbKey: `${publishedId}/upload_thumb.webp`,
        publicKey: `${publishedId}/public_v1.jpg`,
        publicThumbKey: `${publishedId}/public_thumb_v1.webp`,
        variantVersion: 1,
        processedAt: '2026-10-06T10:00:00.000Z',
        deletedAt: null,
      },
      {
        id: otherEventRowId,
        eventId: otherEventId,
        uploaderUserId: GUEST,
        uploadKey: `${otherEventRowId}/upload.jpg`,
        uploadThumbKey: `${otherEventRowId}/upload_thumb.webp`,
        publicKey: `${otherEventRowId}/public_v1.jpg`,
        publicThumbKey: `${otherEventRowId}/public_thumb_v1.webp`,
        variantVersion: 1,
        processedAt: '2026-10-06T10:00:00.000Z',
        deletedAt: null,
      },
      {
        id: unprocessedId,
        eventId,
        uploaderUserId: GUEST,
        uploadKey: `${unprocessedId}/upload.jpg`,
        uploadThumbKey: `${unprocessedId}/upload_thumb.webp`,
        publicKey: null,
        publicThumbKey: null,
        variantVersion: 0,
        processedAt: null,
        deletedAt: null,
      },
      {
        id: deletedId,
        eventId,
        uploaderUserId: GUEST,
        uploadKey: `${deletedId}/upload.jpg`,
        uploadThumbKey: `${deletedId}/upload_thumb.webp`,
        publicKey: `${deletedId}/public_v1.jpg`,
        publicThumbKey: `${deletedId}/public_thumb_v1.webp`,
        variantVersion: 1,
        processedAt: '2026-10-06T10:00:00.000Z',
        deletedAt: '2026-10-06T10:10:00.000Z',
      },
    ];

    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mediaIds: [publishedId, otherEventRowId, unprocessedId, deletedId],
        size: 'full',
      }),
    });
    expect(res.status).toBe(200);
    const body = MediaImagesResponse.parse(await res.json());
    expect(Object.keys(body.images)).toEqual([publishedId]);
  });

  it('allows a Photographer to get only their own published photos signed, omitting others', async () => {
    const ownPhotoId = randomUUID();
    const guestPhotoId = randomUUID();

    mediaImagesStore.records = [
      {
        id: ownPhotoId,
        eventId,
        uploaderUserId: PHOTOGRAPHER,
        uploadKey: `${ownPhotoId}/upload.jpg`,
        uploadThumbKey: `${ownPhotoId}/upload_thumb.webp`,
        publicKey: `${ownPhotoId}/public_v1.jpg`,
        publicThumbKey: `${ownPhotoId}/public_thumb_v1.webp`,
        variantVersion: 1,
        processedAt: '2026-10-06T10:00:00.000Z',
        deletedAt: null,
      },
      {
        id: guestPhotoId,
        eventId,
        uploaderUserId: GUEST,
        uploadKey: `${guestPhotoId}/upload.jpg`,
        uploadThumbKey: `${guestPhotoId}/upload_thumb.webp`,
        publicKey: `${guestPhotoId}/public_v1.jpg`,
        publicThumbKey: `${guestPhotoId}/public_thumb_v1.webp`,
        variantVersion: 1,
        processedAt: '2026-10-06T10:00:00.000Z',
        deletedAt: null,
      },
    ];

    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-photographer',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mediaIds: [ownPhotoId, guestPhotoId],
        size: 'full',
      }),
    });
    expect(res.status).toBe(200);
    const body = MediaImagesResponse.parse(await res.json());
    expect(Object.keys(body.images)).toEqual([ownPhotoId]);
  });
});
