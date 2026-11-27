// DELETE /media/{mediaId} and GET /media/{mediaId} (spec §2.5.6, §4.11.4.2, §4.21, D-130, D-160,
// D-179, arch:media). In-memory fake store matching delete_media and the detail query; rls.test.ts
// exercises the real SQL function and tables against the dev project.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { DeleteMediaResponse, ErrorResponse, MediaDetailResponse } from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { DeleteMediaResult, MediaDetailLookup, MediaStore } from '../../src/services/media';
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

interface FakePhoto {
  eventId: string;
  uploaderUserId: string;
  uploaded: boolean;
  processed: boolean;
  deletedAt: string | null;
  // User ids of Do Not Publish subjects matched in this photo.
  dnpSubjectUserIds: Set<string>;
  hasManualBlur: boolean;
  flaggedByUserIds: Set<string>;
}

class FakeMediaDetailAndDeleteStore implements MediaStore {
  readonly eventsDeleted = new Map<string, boolean>();
  readonly members = new Map<
    string,
    Map<string, { role: MembershipRole; status: MembershipStatus }>
  >();
  readonly photos = new Map<string, FakePhoto>();
  deleteMessages: string[] = [];
  private nextMessageId = 1;

  verificationSchedule = () => Promise.resolve(null);
  statuses = () => Promise.reject(new Error('not used here'));
  start = () => Promise.reject(new Error('not used here'));
  findUpload = () => Promise.resolve(null);
  complete = () => Promise.reject(new Error('not used here'));

  detail(mediaId: string, userId: string): Promise<MediaDetailLookup> {
    const photo = this.photos.get(mediaId);
    if (
      photo === undefined ||
      !photo.processed ||
      photo.deletedAt !== null ||
      this.eventsDeleted.get(photo.eventId) !== false
    ) {
      return Promise.resolve({ outcome: 'not_found' });
    }
    const membership = this.members.get(photo.eventId)?.get(userId);
    if (membership?.status !== 'active') {
      return Promise.resolve({ outcome: 'not_member' });
    }
    const hasPrivacyBlur = [...photo.dnpSubjectUserIds].some((id) => id !== userId);
    return Promise.resolve({
      outcome: 'active',
      role: membership.role,
      detail: {
        hasPrivacyBlur,
        hasManualBlur: photo.hasManualBlur,
        flaggedByMe: photo.flaggedByUserIds.has(userId),
      },
    });
  }

  remove(mediaId: string, userId: string): Promise<DeleteMediaResult> {
    const photo = this.photos.get(mediaId);
    if (photo === undefined || this.eventsDeleted.get(photo.eventId) !== false) {
      return Promise.resolve({ outcome: 'not_found' });
    }
    const membership = this.members.get(photo.eventId)?.get(userId);
    if (membership?.status !== 'active') {
      return Promise.resolve({ outcome: 'not_member' });
    }
    if (photo.uploaderUserId !== userId) {
      if (membership.role === 'admin') {
        if (!photo.uploaded) {
          return Promise.resolve({ outcome: 'not_found' });
        }
      } else {
        return Promise.resolve({ outcome: 'not_uploader' });
      }
    }
    if (photo.deletedAt !== null) {
      return Promise.resolve({ outcome: 'deleted', deletedAt: photo.deletedAt, messageId: null });
    }
    photo.deletedAt = '2026-12-10T14:30:00.123456+00:00';
    this.deleteMessages.push(mediaId);
    const messageId = this.nextMessageId;
    this.nextMessageId += 1;
    return Promise.resolve({ outcome: 'deleted', deletedAt: photo.deletedAt, messageId });
  }
}

let store: FakeMediaDetailAndDeleteStore;
let app: RunningApp;
let eventId: string;
let photoId: string;

beforeAll(async () => {
  store = new FakeMediaDetailAndDeleteStore();
  app = await startApp(testDeps({ verifyToken, media: store }));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.eventsDeleted.clear();
  store.members.clear();
  store.photos.clear();
  store.deleteMessages = [];

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
  store.photos.set(photoId, {
    eventId,
    uploaderUserId: GUEST,
    uploaded: true,
    processed: true,
    deletedAt: null,
    dnpSubjectUserIds: new Set(),
    hasManualBlur: false,
    flaggedByUserIds: new Set(),
  });
});

function send(method: 'GET' | 'DELETE', id: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${app.baseUrl}/media/${id}`, { method, headers });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = ErrorResponse.parse(await res.json());
  expect(body.error.code).toBe(code);
}

describe('DELETE /media/:mediaId', () => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    await expectError(await send('DELETE', photoId, null), 401, 'no_session');
    expect(store.deleteMessages).toEqual([]);
  });

  it('refuses a non-uuid mediaId with 400 invalid_request', async () => {
    await expectError(await send('DELETE', 'not-a-uuid', 'guest'), 400, 'invalid_request');
  });

  it('refuses an unknown photo with 404 not_found', async () => {
    await expectError(await send('DELETE', randomUUID(), 'guest'), 404, 'not_found');
  });

  it('refuses a photo in a soft-deleted event with 404 not_found', async () => {
    store.eventsDeleted.set(eventId, true);
    await expectError(await send('DELETE', photoId, 'guest'), 404, 'not_found');
    await expectError(await send('DELETE', photoId, 'admin'), 404, 'not_found');
    expect(store.deleteMessages).toEqual([]);
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      await expectError(await send('DELETE', photoId, token), 403, 'not_member');
      expect(store.deleteMessages).toEqual([]);
    });
  }

  it("refuses another Guest deleting someone else's photo with 403 not_uploader", async () => {
    await expectError(await send('DELETE', photoId, 'other-guest'), 403, 'not_uploader');
    expect(store.deleteMessages).toEqual([]);
  });

  it("refuses a Photographer deleting someone else's photo with 403 not_uploader", async () => {
    await expectError(await send('DELETE', photoId, 'photographer'), 403, 'not_uploader');
    expect(store.deleteMessages).toEqual([]);
  });

  it('refuses another Guest or Photographer with 403 not_uploader even after the photo is deleted', async () => {
    const first = await send('DELETE', photoId, 'guest');
    expect(first.status).toBe(200);
    await expectError(await send('DELETE', photoId, 'other-guest'), 403, 'not_uploader');
    await expectError(await send('DELETE', photoId, 'photographer'), 403, 'not_uploader');
    expect(store.deleteMessages).toEqual([photoId]);
  });

  it("answers the Admin 404 not_found on another person's unfinished upload, while allowing the uploader", async () => {
    store.photos.get(photoId)!.uploaded = false;
    store.photos.get(photoId)!.processed = false;

    await expectError(await send('DELETE', photoId, 'admin'), 404, 'not_found');
    expect(store.deleteMessages).toEqual([]);

    const byUploader = await send('DELETE', photoId, 'guest');
    expect(byUploader.status).toBe(200);
    expect(byUploader.headers.get('cache-control')).toBe('no-store');
    expect(DeleteMediaResponse.parse(await byUploader.json())).toEqual({
      mediaId: photoId,
      deletedAt: '2026-12-10T14:30:00.123Z',
    });
    expect(store.deleteMessages).toEqual([photoId]);
  });

  it('lets the uploader delete their photo and repeats idempotently with one media_delete message', async () => {
    const first = await send('DELETE', photoId, 'guest');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const firstBody = DeleteMediaResponse.parse(await first.json());
    expect(firstBody).toEqual({
      mediaId: photoId,
      deletedAt: '2026-12-10T14:30:00.123Z',
    });

    const repeatByUploader = await send('DELETE', photoId, 'guest');
    expect(repeatByUploader.status).toBe(200);
    expect(DeleteMediaResponse.parse(await repeatByUploader.json())).toEqual(firstBody);

    const repeatByAdmin = await send('DELETE', photoId, 'admin');
    expect(repeatByAdmin.status).toBe(200);
    expect(DeleteMediaResponse.parse(await repeatByAdmin.json())).toEqual(firstBody);

    expect(store.deleteMessages).toEqual([photoId]);
  });

  it('lets the Admin delete any finished photo, and lets a Photographer delete their own upload', async () => {
    const byAdmin = await send('DELETE', photoId, 'admin');
    expect(byAdmin.status).toBe(200);
    expect(DeleteMediaResponse.parse(await byAdmin.json())).toEqual({
      mediaId: photoId,
      deletedAt: '2026-12-10T14:30:00.123Z',
    });

    const photographerPhoto = randomUUID();
    store.photos.set(photographerPhoto, {
      eventId,
      uploaderUserId: PHOTOGRAPHER,
      uploaded: true,
      processed: false,
      deletedAt: null,
      dnpSubjectUserIds: new Set(),
      hasManualBlur: false,
      flaggedByUserIds: new Set(),
    });
    const byPhotographer = await send('DELETE', photographerPhoto, 'photographer');
    expect(byPhotographer.status).toBe(200);
    expect(DeleteMediaResponse.parse(await byPhotographer.json()).mediaId).toBe(photographerPhoto);
    expect(store.deleteMessages).toEqual([photoId, photographerPhoto]);
  });
});

describe('GET /media/:mediaId', () => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    await expectError(await send('GET', photoId, null), 401, 'no_session');
  });

  it('refuses a non-uuid mediaId with 400 invalid_request', async () => {
    await expectError(await send('GET', 'not-a-uuid', 'guest'), 400, 'invalid_request');
  });

  it('refuses an unknown, unprocessed, deleted photo or deleted event with 404 not_found', async () => {
    await expectError(await send('GET', randomUUID(), 'guest'), 404, 'not_found');

    store.photos.get(photoId)!.processed = false;
    await expectError(await send('GET', photoId, 'guest'), 404, 'not_found');
    store.photos.get(photoId)!.processed = true;

    store.photos.get(photoId)!.deletedAt = '2026-12-10T14:30:00.000Z';
    await expectError(await send('GET', photoId, 'admin'), 404, 'not_found');
    store.photos.get(photoId)!.deletedAt = null;

    store.eventsDeleted.set(eventId, true);
    await expectError(await send('GET', photoId, 'guest'), 404, 'not_found');
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      await expectError(await send('GET', photoId, token), 403, 'not_member');
    });
  }

  it('refuses a Photographer with 403 wrong_role', async () => {
    await expectError(await send('GET', photoId, 'photographer'), 403, 'wrong_role');
  });

  it('returns hasPrivacyBlur false to the sole DNP subject, true to others and to a second DNP subject, with zero subject ids', async () => {
    const photo = store.photos.get(photoId)!;
    photo.dnpSubjectUserIds.add(GUEST);
    photo.hasManualBlur = true;
    photo.flaggedByUserIds.add(OTHER_GUEST);

    // Sole DNP subject sees their own unblurred face, so no privacy blur applies in their file.
    const soleRes = await send('GET', photoId, 'guest');
    expect(soleRes.status).toBe(200);
    expect(soleRes.headers.get('cache-control')).toBe('no-store');
    const soleRaw = (await soleRes.json()) as Record<string, unknown>;
    expect(Object.keys(soleRaw).sort()).toEqual(['flaggedByMe', 'hasManualBlur', 'hasPrivacyBlur']);
    expect(MediaDetailResponse.parse(soleRaw)).toEqual({
      hasPrivacyBlur: false,
      hasManualBlur: true,
      flaggedByMe: false,
    });

    // Another viewer (non-subject) receives the public file with GUEST blurred.
    const otherRes = await send('GET', photoId, 'other-guest');
    expect(otherRes.status).toBe(200);
    expect(MediaDetailResponse.parse(await otherRes.json())).toEqual({
      hasPrivacyBlur: true,
      hasManualBlur: true,
      flaggedByMe: true,
    });

    // With a second DNP subject, both subjects see the other's blurred face.
    photo.dnpSubjectUserIds.add(OTHER_GUEST);
    const guestWithTwo = await send('GET', photoId, 'guest');
    expect(MediaDetailResponse.parse(await guestWithTwo.json())).toEqual({
      hasPrivacyBlur: true,
      hasManualBlur: true,
      flaggedByMe: false,
    });
    const otherWithTwo = await send('GET', photoId, 'other-guest');
    expect(MediaDetailResponse.parse(await otherWithTwo.json())).toEqual({
      hasPrivacyBlur: true,
      hasManualBlur: true,
      flaggedByMe: true,
    });

    // Admin sees privacy and manual blur booleans, flaggedByMe false.
    const adminRes = await send('GET', photoId, 'admin');
    expect(MediaDetailResponse.parse(await adminRes.json())).toEqual({
      hasPrivacyBlur: true,
      hasManualBlur: true,
      flaggedByMe: false,
    });
  });
});
