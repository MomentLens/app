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

type MediaRow = Omit<MediaImagesRecord, 'variantKey' | 'variantThumbKey'>;

// A dnp_subject row, keyed by the subject's user, the way the real store joins it through
// subject.user_id (D-63).
interface SubjectFile {
  mediaId: string;
  userId: string;
  variantKey: string;
  variantThumbKey: string;
}

class FakeMediaImagesStore implements MediaImagesStore {
  records: MediaRow[] = [];
  subjects: SubjectFile[] = [];

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
  mediaImagesStore.subjects = [];
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

// S-21: the subject's own file (D-57, D-86, hb §5.2, hb §11.3). The worker has blurred every
// Do Not Publish face into the public file and written one file per subject.
describe('POST /events/:eventId/media/images, Do Not Publish subjects', () => {
  function photo(uploader: string): MediaRow {
    const id = randomUUID();
    return {
      id,
      eventId,
      uploaderUserId: uploader,
      uploadKey: `${id}/upload.jpg`,
      uploadThumbKey: `${id}/upload_thumb.webp`,
      publicKey: `${id}/public_v1.jpg`,
      publicThumbKey: `${id}/public_thumb_v1.webp`,
      variantVersion: 1,
      processedAt: '2026-11-25T10:00:00.000Z',
      deletedAt: null,
    };
  }

  function subjectIn(row: MediaRow, userId: string): SubjectFile {
    const subjectId = randomUUID();
    const file: SubjectFile = {
      mediaId: row.id,
      userId,
      variantKey: `${row.id}/${subjectId}_v1.jpg`,
      variantThumbKey: `${row.id}/${subjectId}_thumb_v1.webp`,
    };
    mediaImagesStore.subjects.push(file);
    return file;
  }

  async function serve(token: string, mediaIds: string[], size: 'full' | 'thumbnail') {
    const res = await fetch(`${app.baseUrl}/events/${eventId}/media/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaIds, size }),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: res.status === 200 ? MediaImagesResponse.parse(JSON.parse(text)) : null,
    };
  }

  it("gives A the public file of B's photo, and no response to A holds B's key", async () => {
    const row = photo(ADMIN);
    mediaImagesStore.records = [row];
    const b = subjectIn(row, OTHER_GUEST);

    for (const size of ['full', 'thumbnail'] as const) {
      const { status, text, body } = await serve('token-guest', [row.id], size);
      expect(status).toBe(200);
      const key = size === 'full' ? row.publicKey : row.publicThumbKey;
      expect(body?.images[row.id]).toEqual({
        url: `https://r2.test/${key}?signed=true`,
        cacheKey: `${key}#v1`,
        isOwnVariant: false,
      });
      expect(text).not.toContain(b.variantKey);
      expect(text).not.toContain(b.variantThumbKey);
      expect(text).not.toContain(row.uploadKey);
      expect(text).not.toContain(row.uploadThumbKey);
    }
    expect(signedGets).not.toContain(b.variantKey);
    expect(signedGets).not.toContain(b.variantThumbKey);
  });

  it('gives B their own file and thumbnail, flagged as their own', async () => {
    const row = photo(ADMIN);
    mediaImagesStore.records = [row];
    const b = subjectIn(row, OTHER_GUEST);

    const full = await serve('token-other-guest', [row.id], 'full');
    expect(full.body?.images[row.id]).toEqual({
      url: `https://r2.test/${b.variantKey}?signed=true`,
      cacheKey: `${b.variantKey}#v1`,
      isOwnVariant: true,
    });
    const thumb = await serve('token-other-guest', [row.id], 'thumbnail');
    expect(thumb.body?.images[row.id]).toEqual({
      url: `https://r2.test/${b.variantThumbKey}?signed=true`,
      cacheKey: `${b.variantThumbKey}#v1`,
      isOwnVariant: true,
    });
    expect(full.text).not.toContain(row.publicKey);
    expect(full.text).not.toContain(row.uploadKey);
  });

  it('gives each of two subjects only their own file', async () => {
    const row = photo(ADMIN);
    mediaImagesStore.records = [row];
    const b = subjectIn(row, OTHER_GUEST);
    const c = subjectIn(row, GUEST);

    const forB = await serve('token-other-guest', [row.id], 'full');
    expect(forB.body?.images[row.id]?.url).toBe(`https://r2.test/${b.variantKey}?signed=true`);
    expect(forB.text).not.toContain(c.variantKey);

    const forC = await serve('token-guest', [row.id], 'full');
    expect(forC.body?.images[row.id]?.url).toBe(`https://r2.test/${c.variantKey}?signed=true`);
    expect(forC.text).not.toContain(b.variantKey);
  });

  it("gives the Admin, a Guest and a Photographer the public file of someone else's subject photo", async () => {
    const guestPhoto = photo(GUEST);
    const photographerPhoto = photo(PHOTOGRAPHER);
    mediaImagesStore.records = [guestPhoto, photographerPhoto];
    const b1 = subjectIn(guestPhoto, OTHER_GUEST);
    const b2 = subjectIn(photographerPhoto, OTHER_GUEST);

    const cases = [
      ['token-admin', [guestPhoto, photographerPhoto]],
      ['token-guest', [guestPhoto, photographerPhoto]],
      // A Photographer sees only their own uploads (arch §1, D-148).
      ['token-photographer', [photographerPhoto]],
    ] as const;
    for (const [token, visible] of cases) {
      const { body, text } = await serve(token, [guestPhoto.id, photographerPhoto.id], 'full');
      expect(Object.keys(body?.images ?? {}).sort()).toEqual(visible.map((r) => r.id).sort());
      for (const row of visible) {
        expect(body?.images[row.id]).toEqual({
          url: `https://r2.test/${row.publicKey}?signed=true`,
          cacheKey: `${row.publicKey}#v1`,
          isOwnVariant: false,
        });
      }
      expect(text).not.toContain(b1.variantKey);
      expect(text).not.toContain(b2.variantKey);
    }
  });

  it('gives a Photographer who is a subject in their own upload their file and the flag', async () => {
    const row = photo(PHOTOGRAPHER);
    mediaImagesStore.records = [row];
    const own = subjectIn(row, PHOTOGRAPHER);

    const { body } = await serve('token-photographer', [row.id], 'full');
    expect(body?.images[row.id]).toEqual({
      url: `https://r2.test/${own.variantKey}?signed=true`,
      cacheKey: `${own.variantKey}#v1`,
      isOwnVariant: true,
    });
  });

  it('signs nothing for a subject who is pending, blocked, removed or not a member', async () => {
    const row = photo(ADMIN);
    mediaImagesStore.records = [row];
    const files = [PENDING, BLOCKED, REMOVED, OUTSIDER].map((user) => subjectIn(row, user));

    for (const [, token] of NOT_MEMBERS) {
      const { status, text } = await serve(token, [row.id], 'full');
      expect(status).toBe(403);
      for (const file of files) expect(text).not.toContain(file.variantKey);
    }
    expect(signedGets).toEqual([]);
  });

  it("signs nothing for B's file in another event's photo", async () => {
    const row = { ...photo(ADMIN), eventId: otherEventId };
    mediaImagesStore.records = [row];
    subjectIn(row, OTHER_GUEST);

    const { status, body } = await serve('token-other-guest', [row.id], 'full');
    expect(status).toBe(200);
    expect(body?.images).toEqual({});
    expect(signedGets).toEqual([]);
  });

  it('serves the blurred public file of a fail-closed photo with faces, never an upload key', async () => {
    // No threshold yet, so the worker blurred every face and matched no subject (arch §5, D-104).
    const row = photo(ADMIN);
    mediaImagesStore.records = [row];

    for (const token of ['token-admin', 'token-guest', 'token-other-guest']) {
      for (const size of ['full', 'thumbnail'] as const) {
        const { body, text } = await serve(token, [row.id], size);
        const key = size === 'full' ? row.publicKey : row.publicThumbKey;
        expect(body?.images[row.id]?.url).toBe(`https://r2.test/${key}?signed=true`);
        expect(text).not.toContain(row.uploadKey);
        expect(text).not.toContain(row.uploadThumbKey);
      }
    }
    expect(signedGets.some((k) => k.includes('upload'))).toBe(false);
  });
});
