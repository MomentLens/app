// POST /media/{mediaId}/flags (spec §2.5.6, arch:photo_flag, D-179). In-memory fake store matching
// flag_photo; rls.test.ts runs the real function and RLS checks against the dev project.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { ErrorResponse, FlagPhotoResponse } from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import type { VerifyToken } from '../../src/middleware/auth';
import type { FlagPhotoResult, PhotoFlagStore } from '../../src/services/photo-flags';
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
  processed: boolean;
  deleted: boolean;
}

interface StoredFlag {
  mediaId: string;
  userId: string;
  state: 'open' | 'kept';
}

class FakePhotoFlagStore implements PhotoFlagStore {
  readonly eventsDeleted = new Map<string, boolean>();
  readonly members = new Map<
    string,
    Map<string, { role: MembershipRole; status: MembershipStatus }>
  >();
  readonly photos = new Map<string, FakePhoto>();
  flags: StoredFlag[] = [];

  flag(mediaId: string, userId: string): Promise<FlagPhotoResult> {
    const photo = this.photos.get(mediaId);
    if (
      photo === undefined ||
      !photo.processed ||
      photo.deleted ||
      this.eventsDeleted.get(photo.eventId) !== false
    ) {
      return Promise.resolve({ outcome: 'not_found' });
    }
    const membership = this.members.get(photo.eventId)?.get(userId);
    if (membership?.status !== 'active') {
      return Promise.resolve({ outcome: 'not_member' });
    }
    if (membership.role !== 'guest') {
      return Promise.resolve({ outcome: 'wrong_role' });
    }
    const existing = this.flags.find((f) => f.mediaId === mediaId && f.userId === userId);
    if (existing !== undefined) {
      return Promise.resolve({ outcome: 'already_flagged' });
    }
    this.flags.push({ mediaId, userId, state: 'open' });
    return Promise.resolve({ outcome: 'flagged' });
  }
}

let store: FakePhotoFlagStore;
let app: RunningApp;
let eventId: string;
let photoId: string;

beforeAll(async () => {
  store = new FakePhotoFlagStore();
  app = await startApp(testDeps({ verifyToken, photoFlags: store }));
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store.eventsDeleted.clear();
  store.members.clear();
  store.photos.clear();
  store.flags = [];

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

function flag(id: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${app.baseUrl}/media/${id}/flags`, { method: 'POST', headers });
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = ErrorResponse.parse(await res.json());
  expect(body.error.code).toBe(code);
}

describe('POST /media/:mediaId/flags', () => {
  it('refuses an unauthenticated request with 401 no_session', async () => {
    await expectError(await flag(photoId, null), 401, 'no_session');
    expect(store.flags).toEqual([]);
  });

  it('refuses a non-uuid mediaId with 400 invalid_request', async () => {
    await expectError(await flag('not-a-uuid', 'guest'), 400, 'invalid_request');
  });

  it('refuses an unknown, unprocessed, deleted photo or deleted event with 404 not_found', async () => {
    await expectError(await flag(randomUUID(), 'guest'), 404, 'not_found');

    store.photos.get(photoId)!.processed = false;
    await expectError(await flag(photoId, 'guest'), 404, 'not_found');
    store.photos.get(photoId)!.processed = true;

    store.photos.get(photoId)!.deleted = true;
    await expectError(await flag(photoId, 'guest'), 404, 'not_found');
    store.photos.get(photoId)!.deleted = false;

    store.eventsDeleted.set(eventId, true);
    await expectError(await flag(photoId, 'guest'), 404, 'not_found');
    expect(store.flags).toEqual([]);
  });

  for (const [who, token] of NOT_MEMBERS) {
    it(`refuses ${who} with 403 not_member`, async () => {
      await expectError(await flag(photoId, token), 403, 'not_member');
      expect(store.flags).toEqual([]);
    });
  }

  it.each([
    ['the Admin', 'admin'],
    ['a Photographer', 'photographer'],
  ] as const)('refuses %s with 403 wrong_role', async (_who, token) => {
    await expectError(await flag(photoId, token), 403, 'wrong_role');
    expect(store.flags).toEqual([]);
  });

  it('answers 201 on first flag and 200 on repeat without duplicating or reopening kept', async () => {
    const first = await flag(photoId, 'guest');
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(FlagPhotoResponse.parse(await first.json())).toEqual({ flagged: true });
    expect(store.flags).toEqual([{ mediaId: photoId, userId: GUEST, state: 'open' }]);

    const repeatOpen = await flag(photoId, 'guest');
    expect(repeatOpen.status).toBe(200);
    expect(FlagPhotoResponse.parse(await repeatOpen.json())).toEqual({ flagged: true });
    expect(store.flags).toHaveLength(1);

    // Admin keeps the photo (S-24); a repeat by the same Guest answers 200 and leaves state kept.
    store.flags[0]!.state = 'kept';
    const repeatKept = await flag(photoId, 'guest');
    expect(repeatKept.status).toBe(200);
    expect(FlagPhotoResponse.parse(await repeatKept.json())).toEqual({ flagged: true });
    expect(store.flags).toEqual([{ mediaId: photoId, userId: GUEST, state: 'kept' }]);

    // Another Guest can still flag the same photo independently.
    const secondGuest = await flag(photoId, 'other-guest');
    expect(secondGuest.status).toBe(201);
    expect(store.flags).toHaveLength(2);
  });
});
