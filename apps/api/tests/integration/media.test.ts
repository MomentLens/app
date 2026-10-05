// POST /events/{eventId}/media/preflight and POST /media/{mediaId}/complete (arch §4, D-82, D-95,
// D-96, D-122). The event store, the media store and R2 are in-memory fakes. start_upload and
// complete_upload decide the sub-event, the resume, the duplicate and the cap under the event lock,
// so here the media store gives whichever answer a test sets, and each test checks what the service
// does with it. rls.test.ts runs both functions against the dev project.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createClient } from '@supabase/supabase-js';
import { pino } from 'pino';

import {
  CompleteUploadResponse,
  ErrorResponse,
  MediaStatusResponse,
  PreflightUploadResponse,
} from '@momentlens/shared-types';
import type { MembershipRole, MembershipStatus } from '@momentlens/shared-types';

import { uploadKeys } from '../../src/lib/keys';
import type { VerifyToken } from '../../src/middleware/auth';
import type { EventStore, MemberAccess } from '../../src/services/events';
import { createMediaStore, preflightUpload, UPLOAD_LIMITS } from '../../src/services/media';
import type {
  CompleteResult,
  MediaDeps,
  MediaStore,
  NewUpload,
  StartResult,
  UploadLimits,
  UploadRecord,
} from '../../src/services/media';
import { startApp, testDeps } from '../support/app';
import type { RunningApp } from '../support/app';

const ADMIN = randomUUID();
const OTHER_ADMIN = randomUUID();
const GUEST = randomUUID();
const SECOND_GUEST = randomUUID();
const PHOTOGRAPHER = randomUUID();
const PENDING = randomUUID();
const BLOCKED = randomUUID();
const REMOVED = randomUUID();
const OUTSIDER = randomUUID();

const tokens = new Map([
  ['token-admin', ADMIN],
  ['token-other-admin', OTHER_ADMIN],
  ['token-guest', GUEST],
  ['token-second-guest', SECOND_GUEST],
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
  ["another event's Admin", 'token-other-admin'],
] as const;

// Every active role uploads through the same pipeline (D-58).
const UPLOADERS = [
  ['the Admin', 'token-admin', 'admin'],
  ['a Guest', 'token-guest', 'guest'],
  ['a Photographer', 'token-photographer', 'photographer'],
] as const;

interface FakeEvent {
  deleted: boolean;
  albumOpen: boolean;
  members: Map<string, { role: MembershipRole; status: MembershipStatus }>;
}

// Answers only findAccess, which is all the media endpoints read from the event store.
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

// Holds media rows and records every call. start inserts a new row unless `startAnswer` holds an
// answer to give instead. complete marks the row uploaded and counts one message, unless
// `completeAnswer` holds an answer, as the real function gives under its lock.
class FakeMedia implements MediaStore {
  readonly rows = new Map<string, UploadRecord>();
  readonly processed = new Set<string>();
  readonly deleted = new Set<string>();
  readonly statusReads: { eventId: string; userId: string; mediaIds: string[] }[] = [];
  readonly starts: { upload: NewUpload; limits: UploadLimits }[] = [];
  readonly completes: { mediaId: string; userId: string; sizeBytes: number }[] = [];
  startAnswer: StartResult | null = null;
  completeAnswer: CompleteResult | null = null;
  messages = 0;
  failWith: Error | null = null;

  statuses(eventId: string, userId: string, mediaIds: string[]): Promise<MediaStatusResponse> {
    this.statusReads.push({ eventId, userId, mediaIds });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({
      statuses: [...this.rows.values()]
        .filter(
          (row) =>
            mediaIds.includes(row.id) &&
            row.eventId === eventId &&
            row.uploaderUserId === userId &&
            row.uploaded,
        )
        .map((row) => ({
          mediaId: row.id,
          status: this.deleted.has(row.id)
            ? 'deleted'
            : this.processed.has(row.id)
              ? 'published'
              : 'processing',
        })),
    });
  }

  start(upload: NewUpload, limits: UploadLimits): Promise<StartResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.starts.push({ upload, limits });
    if (this.startAnswer) return Promise.resolve(this.startAnswer);
    this.rows.set(upload.mediaId, {
      id: upload.mediaId,
      eventId: upload.eventId,
      uploaderUserId: upload.userId,
      uploadKey: upload.uploadKey,
      uploadThumbKey: upload.uploadThumbKey,
      uploaded: false,
    });
    return Promise.resolve({
      outcome: 'created',
      mediaId: upload.mediaId,
      uploadKey: upload.uploadKey,
      uploadThumbKey: upload.uploadThumbKey,
    });
  }

  findUpload(mediaId: string): Promise<UploadRecord | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    const row = this.rows.get(mediaId);
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  complete(mediaId: string, userId: string, sizeBytes: number): Promise<CompleteResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.completes.push({ mediaId, userId, sizeBytes });
    if (this.completeAnswer) return Promise.resolve(this.completeAnswer);
    const row = this.rows.get(mediaId);
    if (row === undefined) return Promise.resolve({ outcome: 'gone' });
    if (row.uploaded) return Promise.resolve({ outcome: 'completed', messageId: null });
    row.uploaded = true;
    this.messages += 1;
    return Promise.resolve({ outcome: 'completed', messageId: this.messages });
  }
}

// The objects in the bucket, key to size, and every delete asked for.
class FakeBucket {
  readonly objects = new Map<string, number>();
  readonly heads: string[] = [];
  readonly deletes: string[] = [];
  failDeletes = new Set<string>();
  presignGets = 0;

  objectSize = (key: string): Promise<number | null> => {
    this.heads.push(key);
    return Promise.resolve(this.objects.get(key) ?? null);
  };

  deleteObject = (key: string): Promise<void> => {
    this.deletes.push(key);
    if (this.failDeletes.has(key)) return Promise.reject(new Error(`R2 refused to delete ${key}`));
    this.objects.delete(key);
    return Promise.resolve();
  };

  // Pre-flight and completion serve no image, so no test here should ever see a GET signed.
  presignGet = (key: string): Promise<string> => {
    this.presignGets += 1;
    return Promise.reject(new Error(`presigned a GET for ${key}`));
  };
}

// Every PUT signed, by the real presigner, so each URL is a real signature.
const puts: { key: string; contentType: string }[] = [];
const realPresignPut = testDeps().presignPut;
const presignPut = (key: string, contentType: string): Promise<string> => {
  puts.push({ key, contentType });
  return realPresignPut(key, contentType);
};

const logs: Record<string, unknown>[] = [];
const logger = pino(
  { level: 'info' },
  { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
);

let events: FakeEvents;
let media: FakeMedia;
let bucket: FakeBucket;
let app: RunningApp;
let eventId: string;
let subEventId: string;
let otherEventId: string;

beforeAll(async () => {
  events = new FakeEvents();
  media = new FakeMedia();
  bucket = new FakeBucket();
  app = await startApp(
    testDeps({
      logger,
      verifyToken,
      events,
      media,
      objectSize: bucket.objectSize,
      deleteObject: bucket.deleteObject,
      presignGet: bucket.presignGet,
      presignPut,
    }),
  );
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  events.events.clear();
  media.rows.clear();
  media.processed.clear();
  media.deleted.clear();
  media.statusReads.length = 0;
  media.starts.length = 0;
  media.completes.length = 0;
  media.startAnswer = null;
  media.completeAnswer = null;
  media.messages = 0;
  media.failWith = null;
  bucket.objects.clear();
  bucket.heads.length = 0;
  bucket.deletes.length = 0;
  bucket.failDeletes = new Set();
  bucket.presignGets = 0;
  puts.length = 0;
  logs.length = 0;

  eventId = randomUUID();
  subEventId = randomUUID();
  events.events.set(eventId, {
    deleted: false,
    // Closed, as every event is until S-31 gives the Admin the toggle. The check is off (D-122).
    albumOpen: false,
    members: new Map([
      [ADMIN, { role: 'admin', status: 'active' }],
      [GUEST, { role: 'guest', status: 'active' }],
      [SECOND_GUEST, { role: 'guest', status: 'active' }],
      [PHOTOGRAPHER, { role: 'photographer', status: 'active' }],
      [PENDING, { role: 'guest', status: 'pending' }],
      [BLOCKED, { role: 'guest', status: 'blocked' }],
      [REMOVED, { role: 'photographer', status: 'removed' }],
    ]),
  });
  otherEventId = randomUUID();
  events.events.set(otherEventId, {
    deleted: false,
    albumOpen: true,
    members: new Map([[OTHER_ADMIN, { role: 'admin', status: 'active' }]]),
  });
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

// A SHA-256 as the phone sends it: 64 lowercase hex characters.
function hash(): string {
  return (randomUUID() + randomUUID()).replaceAll('-', '');
}

function preflightBody(overrides: Record<string, unknown> = {}) {
  return {
    contentHash: hash(),
    subEventId,
    capturedAt: '2026-12-10T15:42:07.000Z',
    ...overrides,
  };
}

const preflightPath = (id: string = eventId) => `/events/${id}/media/preflight`;
const completePath = (id: string) => `/media/${id}/complete`;
const statusPath = (id: string = eventId) => `/events/${id}/media/status`;

// Checks a URL is a presigned PUT of exactly this key, with its content type signed.
function expectPut(url: string, key: string) {
  const parsed = new URL(url);
  expect(parsed.protocol).toBe('https:');
  expect(parsed.pathname).toBe(`/${key}`);
  expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-type');
}

// A row as pre-flight leaves it, uploaded by `userId`, with both objects in the bucket unless the
// case says otherwise.
function seedUpload(
  userId: string,
  options: { uploaded?: boolean; photo?: boolean; thumbnail?: boolean } = {},
): UploadRecord {
  const id = randomUUID();
  const keys = uploadKeys(id);
  const row: UploadRecord = {
    id,
    eventId,
    uploaderUserId: userId,
    uploadKey: keys.photo,
    uploadThumbKey: keys.thumbnail,
    uploaded: options.uploaded ?? false,
  };
  media.rows.set(id, row);
  if (options.photo ?? true) bucket.objects.set(keys.photo, 2_481_337);
  if (options.thumbnail ?? true) bucket.objects.set(keys.thumbnail, 18_204);
  return row;
}

function serviceDeps(): MediaDeps {
  return {
    events,
    media,
    presignPut,
    objectSize: bucket.objectSize,
    deleteObject: bucket.deleteObject,
    logger,
  };
}

describe('POST /events/{eventId}/media/preflight', () => {
  it('answers 401 no_session with no token, and reaches no store', async () => {
    media.failWith = new Error('the store must not be reached');
    const response = await send('POST', preflightPath(), undefined, preflightBody());
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
  });

  it.each(UPLOADERS)(
    'answers %s 201 with a media id and two PUT URLs for the keys built from it',
    async (_case, token, role) => {
      const body = preflightBody();
      const response = await send('POST', preflightPath(), token, body);
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const json = (await response.json()) as Record<string, unknown>;
      // Only the row's two PUT URLs: no image, no key, nothing about anyone else (root invariant 3).
      expect(Object.keys(json).sort()).toEqual(['mediaId', 'photoUploadUrl', 'thumbnailUploadUrl']);
      const upload = PreflightUploadResponse.parse(json);
      const keys = uploadKeys(upload.mediaId);
      expectPut(upload.photoUploadUrl, keys.photo);
      expectPut(upload.thumbnailUploadUrl, keys.thumbnail);
      expect(media.starts).toEqual([
        {
          upload: {
            mediaId: upload.mediaId,
            eventId,
            subEventId,
            userId: tokens.get(token),
            role,
            contentHash: body.contentHash,
            capturedAt: body.capturedAt,
            uploadKey: keys.photo,
            uploadThumbKey: keys.thumbnail,
          },
          limits: UPLOAD_LIMITS,
        },
      ]);
      expect(bucket.presignGets).toBe(0);
    },
  );

  it('signs the photo as a JPEG and the thumbnail as a WebP', async () => {
    const response = await send('POST', preflightPath(), 'token-guest', preflightBody());
    const upload = PreflightUploadResponse.parse(await response.json());
    const keys = uploadKeys(upload.mediaId);
    expect(puts).toEqual([
      { key: keys.photo, contentType: 'image/jpeg' },
      { key: keys.thumbnail, contentType: 'image/webp' },
    ]);
  });

  it('passes no capture time when the photo has none, so the database stamps the pre-flight', async () => {
    const body = preflightBody();
    delete (body as Partial<typeof body>).capturedAt;
    const response = await send('POST', preflightPath(), 'token-guest', body);
    expect(response.status).toBe(201);
    expect(media.starts[0]?.upload.capturedAt).toBeNull();
  });

  it('takes a null capture time as none, so the database stamps the pre-flight', async () => {
    const response = await send(
      'POST',
      preflightPath(),
      'token-guest',
      preflightBody({ capturedAt: null }),
    );
    expect(response.status).toBe(201);
    expect(media.starts[0]?.upload.capturedAt).toBeNull();
  });

  it('takes the event from the path and never from the body', async () => {
    const response = await send(
      'POST',
      preflightPath(),
      'token-guest',
      preflightBody({ eventId: otherEventId }),
    );
    expect(response.status).toBe(201);
    expect(media.starts[0]?.upload.eventId).toBe(eventId);
  });

  it.each(NOT_MEMBERS)('answers %s 403 not_member, and reaches no store', async (_case, token) => {
    const response = await send('POST', preflightPath(), token, preflightBody());
    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe('not_member');
    expect(media.starts).toEqual([]);
  });

  it('answers 404 not_found for a soft-deleted event, to its Admin too, and reaches no store', async () => {
    const event = events.events.get(eventId);
    if (event) event.deleted = true;
    const response = await send('POST', preflightPath(), 'token-admin', preflightBody());
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
    expect(media.starts).toEqual([]);
  });

  it('answers 404 not_found for an event that does not exist', async () => {
    const response = await send(
      'POST',
      preflightPath(randomUUID()),
      'token-guest',
      preflightBody(),
    );
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
    expect(media.starts).toEqual([]);
  });

  it('uploads to a closed album while the album check is off (D-122)', async () => {
    const response = await send('POST', preflightPath(), 'token-guest', preflightBody());
    expect(response.status).toBe(201);
  });

  describe('with the album check on, as S-31 sets it', () => {
    const request = () => ({ contentHash: hash(), subEventId });

    it('answers 409 album_closed for a closed album, and reaches no store', async () => {
      await expect(
        preflightUpload(serviceDeps(), GUEST, eventId, request(), true),
      ).rejects.toMatchObject({ code: 'album_closed', status: 409 });
      expect(media.starts).toEqual([]);
    });

    it('checks membership first, so a non-member learns nothing about the album', async () => {
      await expect(
        preflightUpload(serviceDeps(), OUTSIDER, eventId, request(), true),
      ).rejects.toMatchObject({ code: 'not_member' });
    });

    it('lets the upload through once the album is open', async () => {
      const event = events.events.get(eventId);
      if (event) event.albumOpen = true;
      await expect(
        preflightUpload(serviceDeps(), GUEST, eventId, request(), true),
      ).resolves.toMatchObject({ created: true });
    });
  });

  it("answers 200 for a resume with the row's own id and keys, re-signed, not the new ones", async () => {
    const existing = randomUUID();
    const keys = uploadKeys(existing);
    media.startAnswer = {
      outcome: 'resumed',
      mediaId: existing,
      uploadKey: keys.photo,
      uploadThumbKey: keys.thumbnail,
    };
    const response = await send('POST', preflightPath(), 'token-guest', preflightBody());
    expect(response.status).toBe(200);
    const upload = PreflightUploadResponse.parse(await response.json());
    expect(upload.mediaId).toBe(existing);
    expectPut(upload.photoUploadUrl, keys.photo);
    expectPut(upload.thumbnailUploadUrl, keys.thumbnail);
    // The keys start_upload was offered for a new row are not the ones signed.
    expect(media.starts[0]?.upload.mediaId).not.toBe(existing);
  });

  it.each([
    ['sub_event_missing', 409, 'sub_event_missing'],
    ['duplicate', 409, 'duplicate'],
    ['full', 422, 'event_full'],
    ['too_many', 422, 'too_many_unfinished'],
    ['not_found', 404, 'not_found'],
  ] as const)(
    'answers start_upload refusing with %s as %i %s, with no URL',
    async (outcome, status, code) => {
      media.startAnswer = { outcome };
      const response = await send('POST', preflightPath(), 'token-guest', preflightBody());
      expect(response.status).toBe(status);
      const json = (await response.json()) as Record<string, unknown>;
      expect(ErrorResponse.parse(json).error.code).toBe(code);
      expect(JSON.stringify(json)).not.toContain('http');
    },
  );

  describe('refuses a body the contract refuses with 400 invalid_request, and reaches no store', () => {
    it.each([
      ['an empty body', {}],
      ['no hash', { subEventId }],
      ['an uppercase hash', { contentHash: hash().toUpperCase(), subEventId }],
      ['a 63-character hash', { contentHash: hash().slice(1), subEventId }],
      ['no sub-event', { contentHash: hash() }],
      ['a sub-event that is not a uuid', { contentHash: hash(), subEventId: 'mehndi' }],
      [
        'a capture time with no zone',
        { contentHash: hash(), subEventId, capturedAt: '2026-12-10T15:42:07' },
      ],
    ])('%s', async (_case, body) => {
      const response = await send('POST', preflightPath(), 'token-guest', body);
      expect(response.status).toBe(400);
      await expect(errorCode(response)).resolves.toBe('invalid_request');
      expect(media.starts).toEqual([]);
    });

    it('an event id that is not a uuid', async () => {
      const response = await send('POST', preflightPath('wedding'), 'token-guest', preflightBody());
      expect(response.status).toBe(400);
      await expect(errorCode(response)).resolves.toBe('invalid_request');
    });

    it('image bytes in place of JSON, which never pass through the API (root invariant 5)', async () => {
      const response = await fetch(`${app.baseUrl}${preflightPath()}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token-guest', 'Content-Type': 'image/jpeg' },
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
      });
      expect(response.status).toBe(400);
      await expect(errorCode(response)).resolves.toBe('invalid_request');
      expect(media.starts).toEqual([]);
    });
  });

  it('answers 500 internal_error naming no cause when the store fails', async () => {
    media.failWith = new Error('connection refused to db.internal');
    const response = await send('POST', preflightPath(), 'token-guest', preflightBody());
    expect(response.status).toBe(500);
    const body = ErrorResponse.parse(await response.json());
    expect(body.error).toEqual({ code: 'internal_error', message: 'Internal error' });
  });
});

describe('POST /media/{mediaId}/complete', () => {
  it('answers 401 no_session with no token, and reaches no store', async () => {
    const row = seedUpload(GUEST);
    media.failWith = new Error('the store must not be reached');
    const response = await send('POST', completePath(row.id), undefined);
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
  });

  it('answers 400 invalid_request for an id that is not a uuid', async () => {
    const response = await send('POST', completePath('photo'), 'token-guest');
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
  });

  it.each(UPLOADERS.map(([name, token]) => [name, token] as const))(
    "answers %s 200 completed, storing the photo's size and not the thumbnail's",
    async (_case, token) => {
      const userId = tokens.get(token) ?? '';
      const row = seedUpload(userId);
      const response = await send('POST', completePath(row.id), token);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(CompleteUploadResponse.parse(await response.json())).toEqual({ status: 'completed' });
      expect(bucket.heads.sort()).toEqual([row.uploadKey, row.uploadThumbKey].sort());
      expect(media.completes).toEqual([{ mediaId: row.id, userId, sizeBytes: 2_481_337 }]);
      expect(media.messages).toBe(1);
      expect(logs).toContainEqual(
        expect.objectContaining({ mediaId: row.id, eventId, messageId: 1 }),
      );
      expect(bucket.presignGets).toBe(0);
    },
  );

  it('answers a repeat 200 completed again and sends no second message', async () => {
    const row = seedUpload(GUEST);
    const first = await send('POST', completePath(row.id), 'token-guest');
    const second = await send('POST', completePath(row.id), 'token-guest');
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(CompleteUploadResponse.parse(await second.json())).toEqual({ status: 'completed' });
    expect(media.messages).toBe(1);
    // The repeat reads the row as finished and asks R2 nothing.
    expect(bucket.heads).toHaveLength(2);
  });

  it('answers 200 when another call finished the row between the read and the lock', async () => {
    const row = seedUpload(GUEST);
    media.completeAnswer = { outcome: 'completed', messageId: null };
    const response = await send('POST', completePath(row.id), 'token-guest');
    expect(response.status).toBe(200);
  });

  it('answers 409 duplicate for a row that no longer exists, and asks R2 nothing', async () => {
    const response = await send('POST', completePath(randomUUID()), 'token-guest');
    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe('duplicate');
    expect(bucket.heads).toEqual([]);
    expect(media.completes).toEqual([]);
  });

  it.each([
    ['another Guest', 'token-second-guest'],
    ["the event's Admin", 'token-admin'],
    ['someone with no membership', 'token-outsider'],
    ["another event's Admin", 'token-other-admin'],
  ])(
    "answers %s 403 not_uploader for someone else's photo, and asks R2 nothing",
    async (_case, token) => {
      const row = seedUpload(GUEST);
      const response = await send('POST', completePath(row.id), token);
      expect(response.status).toBe(403);
      await expect(errorCode(response)).resolves.toBe('not_uploader');
      expect(bucket.heads).toEqual([]);
      expect(media.completes).toEqual([]);
    },
  );

  it.each([
    ['removed', 'token-removed', REMOVED],
    ['blocked', 'token-blocked', BLOCKED],
  ])(
    'answers an uploader %s since pre-flight 403 not_member, and the photo stays unfinished',
    async (_case, token, userId) => {
      const row = seedUpload(userId);
      const response = await send('POST', completePath(row.id), token);
      expect(response.status).toBe(403);
      await expect(errorCode(response)).resolves.toBe('not_member');
      expect(bucket.heads).toEqual([]);
      expect(media.completes).toEqual([]);
      expect(media.rows.get(row.id)?.uploaded).toBe(false);
    },
  );

  it('answers 404 not_found when the event was deleted since pre-flight, and enqueues nothing', async () => {
    const row = seedUpload(GUEST);
    const event = events.events.get(eventId);
    if (event) event.deleted = true;
    const response = await send('POST', completePath(row.id), 'token-guest');
    expect(response.status).toBe(404);
    await expect(errorCode(response)).resolves.toBe('not_found');
    expect(bucket.heads).toEqual([]);
    expect(media.messages).toBe(0);
  });

  it.each([
    ['the photo', { photo: false }],
    ['the thumbnail', { thumbnail: false }],
    ['both files', { photo: false, thumbnail: false }],
  ])(
    'answers 409 upload_missing when %s is not in R2, and leaves the row unfinished with no message',
    async (_case, missing) => {
      const row = seedUpload(GUEST, missing);
      const response = await send('POST', completePath(row.id), 'token-guest');
      expect(response.status).toBe(409);
      await expect(errorCode(response)).resolves.toBe('upload_missing');
      expect(media.completes).toEqual([]);
      expect(media.rows.get(row.id)?.uploaded).toBe(false);
      expect(media.messages).toBe(0);
    },
  );

  it.each([
    ['the photo', 'photo'],
    ['the thumbnail', 'thumbnail'],
  ] as const)(
    'answers 409 upload_missing when %s is empty, and leaves the row unfinished with no message',
    async (_case, file) => {
      const row = seedUpload(GUEST);
      bucket.objects.set(file === 'photo' ? row.uploadKey : row.uploadThumbKey, 0);
      const response = await send('POST', completePath(row.id), 'token-guest');
      expect(response.status).toBe(409);
      await expect(errorCode(response)).resolves.toBe('upload_missing');
      expect(media.completes).toEqual([]);
      expect(media.messages).toBe(0);
    },
  );

  it("answers 409 duplicate when another finished row has the hash, and deletes this row's two objects", async () => {
    const row = seedUpload(GUEST);
    media.completeAnswer = { outcome: 'duplicate' };
    const response = await send('POST', completePath(row.id), 'token-guest');
    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe('duplicate');
    expect(bucket.deletes.sort()).toEqual([row.uploadKey, row.uploadThumbKey].sort());
    expect(bucket.objects.size).toBe(0);
  });

  it('still answers 409 duplicate when an object delete fails, and logs the key', async () => {
    const row = seedUpload(GUEST);
    media.completeAnswer = { outcome: 'duplicate' };
    bucket.failDeletes = new Set([row.uploadKey]);
    const response = await send('POST', completePath(row.id), 'token-guest');
    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe('duplicate');
    // The other object is still deleted.
    expect(bucket.objects.has(row.uploadThumbKey)).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 50, mediaId: row.id, key: row.uploadKey }),
    );
  });

  it('answers 409 duplicate, deleting nothing, when another completion deleted the row under the lock', async () => {
    const row = seedUpload(GUEST);
    media.completeAnswer = { outcome: 'gone' };
    const response = await send('POST', completePath(row.id), 'token-guest');
    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe('duplicate');
    expect(bucket.deletes).toEqual([]);
  });

  it.each([
    ['not_found', 404, 'not_found'],
    ['not_uploader', 403, 'not_uploader'],
  ] as const)(
    'answers complete_upload refusing with %s as %i %s',
    async (outcome, status, code) => {
      const row = seedUpload(GUEST);
      media.completeAnswer = { outcome };
      const response = await send('POST', completePath(row.id), 'token-guest');
      expect(response.status).toBe(status);
      await expect(errorCode(response)).resolves.toBe(code);
      expect(bucket.deletes).toEqual([]);
    },
  );
});

// Status reads return metadata for the authenticated uploader, never image keys or URLs (D-145).
describe('POST /events/{eventId}/media/status', () => {
  it.each(UPLOADERS.map(([name, token]) => [name, token] as const))(
    'returns %s their processing and published rows in a closed album',
    async (_case, token) => {
      const userId = tokens.get(token)!;
      const processing = seedUpload(userId, { uploaded: true });
      const published = seedUpload(userId, { uploaded: true });
      media.processed.add(published.id);
      const response = await send('POST', statusPath(), token, {
        mediaIds: [processing.id, published.id],
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        statuses: [
          { mediaId: processing.id, status: 'processing' },
          { mediaId: published.id, status: 'published' },
        ],
      });
      expect(bucket.heads).toEqual([]);
      expect(bucket.deletes).toEqual([]);
      expect(bucket.presignGets).toBe(0);
      expect(puts).toEqual([]);
      expect(media.starts).toEqual([]);
      expect(media.completes).toEqual([]);
    },
  );

  it.each(UPLOADERS.map(([name, token]) => [name, token] as const))(
    "omits another member's ids for %s, including the Admin",
    async (_case, token) => {
      const own = seedUpload(tokens.get(token)!, { uploaded: true });
      const other = seedUpload(SECOND_GUEST, { uploaded: true });
      const response = await send('POST', statusPath(), token, { mediaIds: [own.id, other.id] });
      expect(response.status).toBe(200);
      expect(MediaStatusResponse.parse(await response.json())).toEqual({
        statuses: [{ mediaId: own.id, status: 'processing' }],
      });
    },
  );

  it('omits my ids under another event path even when I belong to both events', async () => {
    events.events.get(otherEventId)!.members.set(GUEST, { role: 'guest', status: 'active' });
    const row = seedUpload(GUEST, { uploaded: true });
    const response = await send('POST', statusPath(otherEventId), 'token-guest', {
      mediaIds: [row.id],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ statuses: [] });
    expect(media.statusReads).toEqual([
      { eventId: otherEventId, userId: GUEST, mediaIds: [row.id] },
    ]);
  });

  it('omits unknown and unfinished ids, including a soft-deleted unfinished row', async () => {
    const row = seedUpload(GUEST);
    media.deleted.add(row.id);
    const response = await send('POST', statusPath(), 'token-guest', {
      mediaIds: [row.id, randomUUID()],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ statuses: [] });
  });

  it.each([false, true])(
    'returns deleted for an uploaded soft-deleted row, processed=%s',
    async (processed) => {
      const row = seedUpload(GUEST, { uploaded: true });
      media.deleted.add(row.id);
      if (processed) media.processed.add(row.id);
      const response = await send('POST', statusPath(), 'token-guest', { mediaIds: [row.id] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ statuses: [{ mediaId: row.id, status: 'deleted' }] });
    },
  );

  it.each(NOT_MEMBERS)(
    'refuses %s with 403 not_member before reading media',
    async (_case, token) => {
      const response = await send('POST', statusPath(), token, { mediaIds: [randomUUID()] });
      expect(response.status).toBe(403);
      await expect(errorCode(response)).resolves.toBe('not_member');
      expect(media.statusReads).toEqual([]);
    },
  );

  it.each(['deleted', 'unknown'])(
    'refuses a %s event with 404 before reading media',
    async (kind) => {
      if (kind === 'deleted') events.events.get(eventId)!.deleted = true;
      const response = await send(
        'POST',
        statusPath(kind === 'unknown' ? randomUUID() : eventId),
        'token-admin',
        { mediaIds: [randomUUID()] },
      );
      expect(response.status).toBe(404);
      await expect(errorCode(response)).resolves.toBe('not_found');
      expect(media.statusReads).toEqual([]);
    },
  );

  it('authenticates before parsing malformed JSON', async () => {
    const response = await send('POST', statusPath(), undefined, '{');
    expect(response.status).toBe(401);
    await expect(errorCode(response)).resolves.toBe('no_session');
    expect(media.statusReads).toEqual([]);
  });

  const repeated = randomUUID();
  it.each([
    ['zero ids', { mediaIds: [] }],
    ['51 ids', { mediaIds: Array.from({ length: 51 }, () => randomUUID()) }],
    ['repeated ids', { mediaIds: [repeated, repeated] }],
    ['mixed-case repeated ids', { mediaIds: [repeated, repeated.toUpperCase()] }],
    ['invalid UUID', { mediaIds: ['not-an-id'] }],
    ['no body', undefined],
    ['malformed JSON', '{'],
    ['uploader override', { mediaIds: [repeated], userId: SECOND_GUEST }],
    ['event override', { mediaIds: [repeated], eventId: randomUUID() }],
  ])('refuses %s with 400 invalid_request before reading media', async (_case, body) => {
    const response = await send('POST', statusPath(), 'token-guest', body);
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
    expect(media.statusReads).toEqual([]);
  });

  it('refuses an invalid event path', async () => {
    const response = await send('POST', statusPath('not-an-id'), 'token-guest', {
      mediaIds: [randomUUID()],
    });
    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe('invalid_request');
    expect(media.statusReads).toEqual([]);
  });

  it('accepts 50 ids and normalizes UUID spellings', async () => {
    const rows = Array.from({ length: 50 }, () => seedUpload(GUEST, { uploaded: true }));
    const response = await send('POST', statusPath(eventId.toUpperCase()), 'token-guest', {
      mediaIds: rows.map((row) => row.id.toUpperCase()),
    });
    expect(response.status).toBe(200);
    expect(MediaStatusResponse.parse(await response.json()).statuses).toHaveLength(50);
    expect(media.statusReads[0]).toEqual({
      eventId,
      userId: GUEST,
      mediaIds: rows.map((row) => row.id),
    });
  });

  it('returns 500 internal_error when the status store fails', async () => {
    media.failWith = new Error('database unavailable');
    const response = await send('POST', statusPath(), 'token-guest', { mediaIds: [randomUUID()] });
    expect(response.status).toBe(500);
    await expect(errorCode(response)).resolves.toBe('internal_error');
  });
});

// Exercise the real Supabase query builder so an unscoped query cannot hide behind FakeMedia.
describe('media status database read', () => {
  it('scopes the query to the event, uploader, requested ids and uploaded rows, keeping deleted rows', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const request = jest.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            { id: ids[0], processed_at: null, deleted_at: null },
            { id: ids[1], processed_at: '2026-10-05T08:00:00Z', deleted_at: null },
            {
              id: ids[2],
              processed_at: '2026-10-05T08:00:00Z',
              deleted_at: '2026-10-05T09:00:00Z',
            },
          ]),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const client = createClient('https://database.test', 'test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: request },
    });
    await expect(createMediaStore(client).statuses(eventId, GUEST, ids)).resolves.toEqual({
      statuses: [
        { mediaId: ids[0], status: 'processing' },
        { mediaId: ids[1], status: 'published' },
        { mediaId: ids[2], status: 'deleted' },
      ],
    });
    expect(request).toHaveBeenCalledTimes(1);
    const input = request.mock.calls[0]![0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.pathname).toBe('/rest/v1/media');
    expect(url.searchParams.get('event_id')).toBe(`eq.${eventId}`);
    expect(url.searchParams.get('uploader_user_id')).toBe(`eq.${GUEST}`);
    expect(url.searchParams.get('id')).toBe(`in.(${ids.join(',')})`);
    expect(url.searchParams.get('uploaded_at')).toBe('not.is.null');
    expect(url.searchParams.has('deleted_at')).toBe(false);
    expect(
      url.searchParams
        .get('select')
        ?.split(',')
        .map((column) => column.trim())
        .sort(),
    ).toEqual(['deleted_at', 'id', 'processed_at']);
  });
});
