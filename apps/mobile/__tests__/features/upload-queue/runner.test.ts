import { beforeEach, describe, expect, it } from '@jest/globals';
import type {
  CompleteUploadResponse,
  PreflightUploadRequest,
  PreflightUploadResponse,
} from '@momentlens/shared-types';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  UploadRunner,
  type NetworkGate,
  type PutResult,
  type RunnerDeps,
} from '@/features/upload-queue/runner';
import { QueueStore, type QueueDatabase, type QueueFiles } from '@/features/upload-queue/store';
import type { QueueItem } from '@/features/upload-queue/types';

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const OTHER_EVENT = '5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e';
const SUB = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const photo = { uri: 'file:///picker/photo.heic', capturedAt: null };

// An error shaped like lib/api's ApiError: the status and code the transitions read.
class AnswerError extends Error {
  constructor(
    readonly status?: number,
    readonly code?: string,
    readonly timedOut = false,
  ) {
    super(`HTTP ${status ?? 'no answer'} ${code ?? ''}`);
  }
}
const noAnswer = () => new AnswerError(undefined, undefined, true);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The condition never held');
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// S-12's pre-flight and completion, as arch §4 steps 2 to 5 describe them. A test scripts an
// answer by pushing a function that runs in place of the next call.
interface ServerRow {
  id: string;
  userId: string;
  hash: string;
  finished: boolean;
}
type ServerCall =
  | { call: 'preflight'; userId: string; eventId: string; body: PreflightUploadRequest }
  | { call: 'complete'; userId: string; mediaId: string };
class Server {
  rows = new Map<string, ServerRow>();
  calls: ServerCall[] = [];
  preflightScript: ((signal: AbortSignal) => Promise<PreflightUploadResponse>)[] = [];
  completeScript: ((signal: AbortSignal) => Promise<CompleteUploadResponse>)[] = [];
  urls(id: string): PreflightUploadResponse {
    return {
      mediaId: id,
      photoUploadUrl: `https://r2.example.test/${id}/photo?sig=1`,
      thumbnailUploadUrl: `https://r2.example.test/${id}/thumb?sig=1`,
    };
  }
  async preflight(
    userId: string,
    eventId: string,
    body: PreflightUploadRequest,
    signal: AbortSignal,
  ) {
    this.calls.push({ call: 'preflight', userId, eventId, body });
    const scripted = this.preflightScript.shift();
    if (scripted) return scripted(signal);
    return this.realPreflight(userId, body);
  }
  realPreflight(userId: string, body: PreflightUploadRequest): PreflightUploadResponse {
    const rows = [...this.rows.values()];
    const own = rows.find(
      (row) => row.userId === userId && row.hash === body.contentHash && !row.finished,
    );
    if (own) return this.urls(own.id);
    if (rows.some((row) => row.hash === body.contentHash && row.finished)) {
      throw new AnswerError(409, 'duplicate');
    }
    const id = randomUUID();
    this.rows.set(id, { id, userId, hash: body.contentHash, finished: false });
    return this.urls(id);
  }
  async complete(userId: string, mediaId: string, signal: AbortSignal) {
    this.calls.push({ call: 'complete', userId, mediaId });
    const scripted = this.completeScript.shift();
    if (scripted) return scripted(signal);
    return this.realComplete(userId, mediaId);
  }
  realComplete(userId: string, mediaId: string): CompleteUploadResponse {
    const row = this.rows.get(mediaId);
    if (!row) throw new AnswerError(409, 'duplicate');
    if (row.userId !== userId) throw new AnswerError(403, 'not_uploader');
    row.finished = true;
    return { status: 'completed' };
  }
  count(call: ServerCall['call']) {
    return this.calls.filter((entry) => entry.call === call).length;
  }
}

interface Put {
  path: string;
  url: string;
  contentType: string;
  bytes: Uint8Array;
}
let database: DatabaseSync;
let disk: Map<string, Uint8Array>;
let store: QueueStore;
let server: Server;
let user: string | null;
let clock: number;
let gate: NetworkGate;
let puts: Put[];
let putScript: ((signal: AbortSignal) => Promise<PutResult>)[];
let prepares: string[];
let prepareScript: (() => Promise<never>)[];
let lost: string[];
let timers: { wake: () => void; at: number; cancelled: boolean }[];
let nextId: number;

function createStore() {
  const db: QueueDatabase = {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...params) => ({
      changes: Number(database.prepare(sql).run(...params).changes),
    }),
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      database.prepare(sql).all(...params) as T[],
  };
  const files: QueueFiles = {
    copy: async (owner, id) => {
      const photoPath = `${owner}/${id}/source.heic`;
      const thumbnailPath = `${owner}/${id}/thumb.webp`;
      disk.set(photoPath, new TextEncoder().encode(`heic:${id}`));
      disk.set(thumbnailPath, new TextEncoder().encode(`webp:${id}`));
      return { photoPath, thumbnailPath };
    },
    delete: async (path) => {
      disk.delete(path);
    },
    list: async () => [...disk.keys()],
    uri: (path) => `file:///documents/upload-queue/${path}`,
  };
  return new QueueStore(db, files, () => `item-${++nextId}`);
}

function createRunner(overrides: Partial<RunnerDeps> = {}) {
  const own = store;
  const deps: RunnerDeps = {
    store: async () => own,
    userId: () => user,
    prepare: async (item: QueueItem) => {
      prepares.push(item.id);
      const scripted = prepareScript.shift();
      if (scripted) return scripted();
      // Stage 1's output: new bytes at upload.jpg in the photo's own folder.
      const photoPath = `${item.userId}/${item.id}/upload.jpg`;
      const bytes = new TextEncoder().encode(`jpeg:${item.id}`);
      disk.set(photoPath, bytes);
      return { photoPath, contentHash: sha256(bytes) };
    },
    discard: async (path) => {
      disk.delete(path);
    },
    preflight: (userId, eventId, body, signal) => server.preflight(userId, eventId, body, signal),
    complete: (userId, mediaId, signal) => server.complete(userId, mediaId, signal),
    put: async (path, url, contentType, signal) => {
      const bytes = disk.get(path);
      if (!bytes) return 'missing';
      puts.push({ path, url, contentType, bytes });
      const scripted = putScript.shift();
      return scripted ? scripted(signal) : 'ok';
    },
    gate: async () => gate,
    lostAccess: (eventId) => {
      lost.push(eventId);
    },
    now: () => clock,
    schedule: (wake, delayMs) => {
      const timer = { wake, at: clock + delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    warn: () => undefined,
    ...overrides,
  };
  return new UploadRunner(deps);
}

// Moves the clock to the earliest live timer and fires it.
async function fireNextTimer(runner: UploadRunner) {
  const live = timers.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at);
  const next = live[0];
  if (!next) throw new Error('No timer is scheduled');
  clock = Math.max(clock, next.at);
  next.cancelled = true;
  next.wake();
  await runner.run();
}

async function only(userId = 'A', eventId = EVENT) {
  const rows = await store.listForEvent(userId, eventId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  disk = new Map();
  nextId = 0;
  store = createStore();
  server = new Server();
  user = 'A';
  clock = 1_000_000;
  gate = 'open';
  puts = [];
  putScript = [];
  prepares = [];
  prepareScript = [];
  lost = [];
  timers = [];
});

describe('one photo through the loop', () => {
  it('prepares once, pre-flights, PUTs both files to their own URLs, completes and keeps the thumbnail', async () => {
    const item = await store.enqueue('A', EVENT, SUB, photo);
    await createRunner().run();

    const [preflight, complete] = server.calls;
    expect(preflight).toMatchObject({ call: 'preflight', userId: 'A', eventId: EVENT });
    const mediaId = [...server.rows.keys()][0]!;
    expect(complete).toEqual({ call: 'complete', userId: 'A', mediaId });
    expect(puts.map(({ path, url, contentType }) => ({ path, url, contentType }))).toEqual([
      {
        path: 'A/item-1/upload.jpg',
        url: server.urls(mediaId).photoUploadUrl,
        contentType: 'image/jpeg',
      },
      {
        path: item.thumbnailPath,
        url: server.urls(mediaId).thumbnailUploadUrl,
        contentType: 'image/webp',
      },
    ]);
    expect(await only()).toMatchObject({
      state: 'uploaded',
      mediaId,
      photoPath: null,
      thumbnailPath: item.thumbnailPath,
    });
    // The source went when upload.jpg was stored, and upload.jpg when completion answered.
    expect([...disk.keys()]).toEqual([item.thumbnailPath]);
    expect(server.rows.get(mediaId)?.finished).toBe(true);
  });

  it('sends the EXIF capture time, or the time the photo entered the queue (D-147)', async () => {
    const exif = '2026-10-04T10:15:30.000Z';
    await store.enqueue('A', EVENT, SUB, { uri: photo.uri, capturedAt: exif });
    const added = await store.enqueue('A', EVENT, SUB, photo);
    await createRunner().run();
    const sent = server.calls.flatMap((entry) => (entry.call === 'preflight' ? [entry.body] : []));
    expect(sent.map((body) => body.capturedAt)).toEqual([
      exif,
      new Date(added.createdAt).toISOString(),
    ]);
    expect(sent.every((body) => body.subEventId === SUB)).toBe(true);
  });

  it('moves the oldest photo first across events', async () => {
    await store.enqueue('A', OTHER_EVENT, SUB, photo);
    await store.enqueue('A', EVENT, SUB, photo);
    await createRunner().run();
    expect(prepares).toEqual(['item-1', 'item-2']);
  });
});

describe('root invariant 7: the hash is SHA-256 of the exact upload.jpg bytes PUT', () => {
  it('sends the hash of the file it PUTs to the photo URL', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    await createRunner().run();
    const preflight = server.calls[0];
    if (preflight?.call !== 'preflight') throw new Error('No pre-flight');
    const photoPut = puts.find((put) => put.contentType === 'image/jpeg')!;
    expect(sha256(photoPut.bytes)).toBe(preflight.body.contentHash);
    expect(photoPut.path).toBe('A/item-1/upload.jpg');
  });

  it('never runs Stage 1 again once the hash is stored, across a retry and a relaunch', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(noAnswer()));
    await createRunner().run();
    expect(await only()).toMatchObject({ step: 'preflight', state: 'queued' });

    // A relaunch: a new store on the same database, a new runner.
    store = createStore();
    await createRunner().retryNow();
    expect(prepares).toEqual(['item-1']);
    const hashes = server.calls.flatMap((entry) =>
      entry.call === 'preflight' ? [entry.body.contentHash] : [],
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
    expect((await only()).state).toBe('uploaded');
  });
});

describe('root invariant 13: the thumbnail goes only to thumbnailUploadUrl', () => {
  it('PUTs the thumbnail once, as WebP, to the thumbnail URL and the photo nowhere else', async () => {
    const item = await store.enqueue('A', EVENT, SUB, photo);
    await createRunner().run();
    const mediaId = [...server.rows.keys()][0]!;
    const thumbnailPuts = puts.filter((put) => put.path === item.thumbnailPath);
    expect(thumbnailPuts).toEqual([
      expect.objectContaining({
        url: server.urls(mediaId).thumbnailUploadUrl,
        contentType: 'image/webp',
      }),
    ]);
    expect(puts.filter((put) => put.url === server.urls(mediaId).thumbnailUploadUrl)).toHaveLength(
      1,
    );
  });
});

describe('every arch §4 answer moves the photo to its state', () => {
  // Pre-flight answers. Each row is what the queue holds after the answer.
  it.each<[string, AnswerError, Partial<QueueItem>]>([
    [
      'no answer',
      noAnswer(),
      { state: 'queued', step: 'preflight', retryCount: 1, nextRetryAt: 1_005_000 },
    ],
    [
      '500 internal_error',
      new AnswerError(500, 'internal_error'),
      { state: 'queued', step: 'preflight', retryCount: 1, nextRetryAt: 1_005_000 },
    ],
    [
      'a 200 that is not JSON',
      new AnswerError(200),
      { state: 'queued', step: 'preflight', retryCount: 1 },
    ],
    [
      '401 no_session',
      new AnswerError(401, 'no_session'),
      { state: 'queued', step: 'preflight', retryCount: 0, nextRetryAt: null },
    ],
    [
      '400 invalid_request',
      new AnswerError(400, 'invalid_request'),
      { state: 'stopped', stoppedReason: 'invalid_request' },
    ],
    [
      '409 album_closed',
      new AnswerError(409, 'album_closed'),
      { state: 'waiting_album', stoppedReason: null },
    ],
    [
      '409 unverified',
      new AnswerError(409, 'unverified'),
      { state: 'waiting_verification', stoppedReason: null },
    ],
    [
      '422 event_full',
      new AnswerError(422, 'event_full'),
      { state: 'stopped', stoppedReason: 'event_full' },
    ],
    [
      '422 too_many_unfinished',
      new AnswerError(422, 'too_many_unfinished'),
      { state: 'stopped', stoppedReason: 'too_many_unfinished' },
    ],
    [
      '409 sub_event_missing',
      new AnswerError(409, 'sub_event_missing'),
      { state: 'stopped', stoppedReason: 'sub_event_missing' },
    ],
    [
      '403 not_member',
      new AnswerError(403, 'not_member'),
      { state: 'stopped', stoppedReason: 'not_member', step: 'preflight' },
    ],
    [
      '404 not_found',
      new AnswerError(404, 'not_found'),
      { state: 'stopped', stoppedReason: 'not_found', step: 'preflight' },
    ],
  ])('pre-flight %s', async (_name, error, expected) => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(error));
    await createRunner().run();
    expect(await only()).toMatchObject(expected);
    expect(puts).toEqual([]);
    expect(server.count('complete')).toBe(0);
  });

  it('pre-flight 409 duplicate leaves the queue with its files and no prompt', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(new AnswerError(409, 'duplicate')));
    await createRunner().run();
    expect(await store.listForEvent('A', EVENT)).toEqual([]);
    expect([...disk.keys()]).toEqual([]);
  });

  it('pre-flight 403 and 404 ask the Event shell to check the event again', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(new AnswerError(403, 'not_member')));
    await createRunner().run();
    expect(lost).toEqual([EVENT]);
  });

  it('pre-flight 201 or 200 makes it uploading at the photo PUT', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const hang = deferred<PutResult>();
    putScript.push(() => hang.promise);
    const running = createRunner().run();
    await until(() => puts.length === 1);
    const mediaId = [...server.rows.keys()][0]!;
    expect(await only()).toMatchObject({ state: 'uploading', step: 'put_photo', mediaId });
    hang.resolve('ok');
    await running;
  });

  it.each([
    ['the photo PUT', 0],
    ['the thumbnail PUT', 1],
  ])(
    'a failed %s goes back to queued at pre-flight and sends both files next time',
    async (_name, failing) => {
      await store.enqueue('A', EVENT, SUB, photo);
      if (failing === 1) putScript.push(async () => 'ok');
      putScript.push(async () => 'failed');
      const runner = createRunner();
      await runner.run();
      expect(await only()).toMatchObject({
        state: 'queued',
        step: 'preflight',
        retryCount: 1,
        nextRetryAt: clock + 5_000,
      });
      await fireNextTimer(runner);
      expect(server.count('preflight')).toBe(2);
      expect(server.rows.size).toBe(1);
      expect(puts.slice(failing + 1).map((put) => put.contentType)).toEqual([
        'image/jpeg',
        'image/webp',
      ]);
      expect((await only()).state).toBe('uploaded');
    },
  );

  // Completion answers, after both PUTs.
  it.each<[string, AnswerError, Partial<QueueItem>]>([
    [
      'no answer',
      noAnswer(),
      { state: 'uploading', step: 'complete', retryCount: 1, nextRetryAt: 1_005_000 },
    ],
    ['503', new AnswerError(503), { state: 'uploading', step: 'complete', retryCount: 1 }],
    [
      '401 no_session',
      new AnswerError(401, 'no_session'),
      { state: 'uploading', step: 'complete', retryCount: 0 },
    ],
    [
      '400 invalid_request',
      new AnswerError(400, 'invalid_request'),
      { state: 'stopped', stoppedReason: 'invalid_request' },
    ],
    [
      '403 not_member',
      new AnswerError(403, 'not_member'),
      { state: 'stopped', stoppedReason: 'not_member', step: 'complete' },
    ],
    [
      '404 not_found',
      new AnswerError(404, 'not_found'),
      { state: 'stopped', stoppedReason: 'not_found', step: 'complete' },
    ],
    [
      '403 not_uploader',
      new AnswerError(403, 'not_uploader'),
      { state: 'stopped', stoppedReason: 'not_uploader' },
    ],
    [
      '409 upload_missing',
      new AnswerError(409, 'upload_missing'),
      { state: 'queued', step: 'preflight', retryCount: 1 },
    ],
  ])('completion %s', async (_name, error, expected) => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.completeScript.push(() => Promise.reject(error));
    await createRunner().run();
    expect(await only()).toMatchObject(expected);
    expect(server.count('preflight')).toBe(1);
  });

  it('completion 409 duplicate leaves the queue with its files and no prompt', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.completeScript.push(() => Promise.reject(new AnswerError(409, 'duplicate')));
    await createRunner().run();
    expect(await store.listForEvent('A', EVENT)).toEqual([]);
    expect([...disk.keys()]).toEqual([]);
  });

  it('completion 409 upload_missing resumes the row with fresh URLs and sends both files again', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.completeScript.push(() => Promise.reject(new AnswerError(409, 'upload_missing')));
    const runner = createRunner();
    await runner.run();
    await fireNextTimer(runner);
    expect(server.rows.size).toBe(1);
    expect(puts.map((put) => put.contentType)).toEqual([
      'image/jpeg',
      'image/webp',
      'image/jpeg',
      'image/webp',
    ]);
    expect((await only()).state).toBe('uploaded');
  });
});

describe('a kill or a lost answer', () => {
  it('resumes after a kill past pre-flight and never drops the photo as its own duplicate', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    // The app dies during the photo PUT. Nothing from the first process runs again.
    putScript.push(() => new Promise<PutResult>(() => undefined));
    void createRunner().run();
    await until(() => puts.length === 1);

    store = createStore();
    await createRunner().run();
    expect(server.count('preflight')).toBe(2);
    expect(server.rows.size).toBe(1);
    const mediaId = [...server.rows.keys()][0]!;
    expect(server.rows.get(mediaId)?.finished).toBe(true);
    expect(await only()).toMatchObject({ state: 'uploaded', mediaId });
  });

  it('shows a photo killed mid-upload as queued again, so My Media can delete it', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    putScript.push(() => new Promise<PutResult>(() => undefined));
    void createRunner().run();
    await until(() => puts.length === 1);

    store = createStore();
    gate = 'offline';
    await createRunner().run();
    expect(await only()).toMatchObject({ state: 'queued', step: 'preflight' });
    expect(await store.remove('A', 'item-1')).toBe(true);
  });

  it('after a lost completion answer, completes again and never pre-flights', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    // The server marks the photo uploaded, and the answer never reaches the phone.
    server.completeScript.push(async () => {
      const mediaId = [...server.rows.keys()][0]!;
      server.realComplete('A', mediaId);
      throw noAnswer();
    });
    const runner = createRunner();
    await runner.run();
    expect(await only()).toMatchObject({ state: 'uploading', step: 'complete' });

    await fireNextTimer(runner);
    expect(server.count('preflight')).toBe(1);
    expect(server.count('complete')).toBe(2);
    expect((await only()).state).toBe('uploaded');
  });

  it('completes again after a relaunch when the completion answer was lost', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.completeScript.push(() => new Promise<CompleteUploadResponse>(() => undefined));
    void createRunner().run();
    await until(() => server.count('complete') === 1);

    store = createStore();
    await createRunner().run();
    expect(server.count('preflight')).toBe(1);
    expect(server.count('complete')).toBe(2);
    expect((await only()).state).toBe('uploaded');
  });

  it('counts a kill during Stage 1 and stops the photo after the third (D-146)', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    for (let launch = 1; launch <= 3; launch++) {
      prepareScript.push(() => new Promise<never>(() => undefined));
      store = createStore();
      void createRunner().run();
      await until(() => prepares.length === launch);
    }
    store = createStore();
    await createRunner().run();
    expect(prepares).toHaveLength(3);
    expect(await only()).toMatchObject({ state: 'stopped', stoppedReason: 'invalid_request' });
    expect(server.calls).toEqual([]);
  });

  it('stops a photo whose Stage 1 fails three times, with backoff between', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    for (let i = 0; i < 3; i++) prepareScript.push(() => Promise.reject(new Error('decode')));
    const runner = createRunner();
    await runner.run();
    expect(await only()).toMatchObject({
      state: 'queued',
      step: 'prepare',
      retryCount: 1,
      nextRetryAt: clock + 5_000,
    });
    await fireNextTimer(runner);
    expect(await only()).toMatchObject({ retryCount: 2, nextRetryAt: clock + 10_000 });
    await fireNextTimer(runner);
    expect(await only()).toMatchObject({ state: 'stopped', stoppedReason: 'invalid_request' });
    expect(server.calls).toEqual([]);
  });
});

describe('the account that queued the photo', () => {
  it('cancels the PUT when the account changes, sends nothing more and leaves the item as it was', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    putScript.push(
      (signal) =>
        new Promise<PutResult>((resolve) => {
          signal.addEventListener('abort', () => resolve('failed'));
        }),
    );
    const runner = createRunner();
    const running = runner.run();
    await until(() => puts.length === 1);
    const before = await only();

    user = 'B';
    void runner.accountChanged();
    await running;
    expect(await only()).toEqual(before);
    expect(server.calls).toHaveLength(1);
    expect(server.calls.every((entry) => entry.userId === 'A')).toBe(true);
    expect(puts).toHaveLength(1);
  });

  it('ignores a pre-flight answer that arrives after the account changed', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const answer = deferred<PreflightUploadResponse>();
    server.preflightScript.push(() => answer.promise);
    const runner = createRunner();
    const running = runner.run();
    await until(() => server.count('preflight') === 1);
    const before = await only();

    user = 'B';
    void runner.accountChanged();
    answer.resolve(server.urls(randomUUID()));
    await running;
    expect(await only()).toEqual(before);
    expect(puts).toEqual([]);
  });

  it('ignores a completion answer that arrives after the account changed', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const answer = deferred<CompleteUploadResponse>();
    server.completeScript.push(() => answer.promise);
    const runner = createRunner();
    const running = runner.run();
    await until(() => server.count('complete') === 1);

    user = null;
    void runner.accountChanged();
    answer.resolve({ status: 'completed' });
    await running;
    expect(await only()).toMatchObject({ state: 'uploading', step: 'complete' });
  });

  it('finishes the photo when its account signs back in', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    putScript.push(
      (signal) =>
        new Promise<PutResult>((resolve) => {
          signal.addEventListener('abort', () => resolve('failed'));
        }),
    );
    const runner = createRunner();
    const running = runner.run();
    await until(() => puts.length === 1);
    user = 'B';
    void runner.accountChanged();
    await running;

    user = 'A';
    await runner.accountChanged();
    expect(server.rows.size).toBe(1);
    expect((await only()).state).toBe('uploaded');
    expect(server.calls.every((entry) => entry.userId === 'A')).toBe(true);
  });

  it('never picks another account’s photos or a Local Only photo', async () => {
    await store.enqueue('B', EVENT, SUB, photo);
    await store.enqueue('A', EVENT, SUB, photo);
    await store.update('A', 'item-2', { state: 'local_only' });
    await createRunner().run();
    expect(prepares).toEqual([]);
    expect(server.calls).toEqual([]);
    expect((await only('B')).state).toBe('queued');
    expect((await only('A')).state).toBe('local_only');
  });

  it('starts nothing with nobody signed in', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    user = null;
    await createRunner().run();
    expect(prepares).toEqual([]);
  });
});

describe('My Media Delete racing the runner', () => {
  it('lets a Delete before the pre-flight answer win, and PUTs nothing for the deleted row', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const answer = deferred<PreflightUploadResponse>();
    server.preflightScript.push(() => answer.promise);
    const running = createRunner().run();
    await until(() => server.count('preflight') === 1);

    expect(await store.remove('A', 'item-1')).toBe(true);
    answer.resolve(server.urls(randomUUID()));
    await running;
    expect(puts).toEqual([]);
    expect(server.count('complete')).toBe(0);
    expect(await store.listForEvent('A', EVENT)).toEqual([]);
    expect([...disk.keys()]).toEqual([]);
  });

  it('refuses a Delete once the photo is uploading, and the upload finishes', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const hang = deferred<PutResult>();
    putScript.push(() => hang.promise);
    const running = createRunner().run();
    await until(() => puts.length === 1);

    expect(await store.remove('A', 'item-1')).toBe(false);
    hang.resolve('ok');
    await running;
    expect((await only()).state).toBe('uploaded');
  });

  it('cleans up the prepared file when a Delete lands during Stage 1', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const release = deferred<void>();
    const runner = createRunner({
      prepare: async (item) => {
        prepares.push(item.id);
        const photoPath = `${item.userId}/${item.id}/upload.jpg`;
        const bytes = new TextEncoder().encode('jpeg');
        disk.set(photoPath, bytes);
        await release.promise;
        return { photoPath, contentHash: sha256(bytes) };
      },
    });
    const running = runner.run();
    await until(() => prepares.length === 1);
    expect(await store.remove('A', 'item-1')).toBe(true);
    release.resolve();
    await running;
    expect(server.calls).toEqual([]);
    expect([...disk.keys()]).toEqual([]);
  });
});

describe('waiting, backoff and release', () => {
  it('backs off 5 seconds doubling, and pauses the whole runner after a failure with no answer', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(noAnswer()));
    const runner = createRunner();
    await runner.run();
    // The second photo waits for the pause rather than meeting the same outage at once.
    expect(server.count('preflight')).toBe(1);
    expect(timers.filter((timer) => !timer.cancelled).map((timer) => timer.at)).toEqual([
      clock + 5_000,
    ]);

    server.preflightScript.push(() => Promise.reject(noAnswer()));
    await fireNextTimer(runner);
    const first = (await store.listForEvent('A', EVENT)).find((row) => row.id === 'item-1')!;
    expect(first).toMatchObject({ retryCount: 2, nextRetryAt: clock + 10_000 });
    expect(prepares).toEqual(['item-1']);

    // The first photo's own backoff is now longer than the pause, so the second goes next.
    await fireNextTimer(runner);
    expect(prepares).toEqual(['item-1', 'item-2']);
  });

  it('retries every photo at once on the foreground, ignoring its backoff', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(noAnswer()));
    const runner = createRunner();
    await runner.run();
    expect((await only()).nextRetryAt).toBe(clock + 5_000);

    await runner.retryNow();
    expect((await only()).state).toBe('uploaded');
  });

  it('waits on a 401 without a timer until something wakes it', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(new AnswerError(401, 'no_session')));
    const runner = createRunner();
    await runner.run();
    expect(server.count('preflight')).toBe(1);
    expect(timers.filter((timer) => !timer.cancelled)).toEqual([]);

    await runner.retryNow();
    const rows = await store.listForEvent('A', EVENT);
    expect(rows.map((row) => row.state)).toEqual(['uploaded', 'uploaded']);
  });

  it('waits offline, and on cellular while Upload over Mobile Data is off', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    const runner = createRunner();
    for (const closed of ['offline', 'cellular'] as const) {
      gate = closed;
      await runner.run();
      expect(prepares).toEqual([]);
      expect(server.calls).toEqual([]);
    }
    gate = 'open';
    await runner.run();
    expect((await only()).state).toBe('uploaded');
  });

  it.each(['waiting_album', 'waiting_verification'] as const)(
    'release moves %s photos of that event back to queued, and they upload',
    async (state) => {
      await store.enqueue('A', EVENT, SUB, photo);
      await store.enqueue('A', OTHER_EVENT, SUB, photo);
      const code = state === 'waiting_album' ? 'album_closed' : 'unverified';
      server.preflightScript.push(
        () => Promise.reject(new AnswerError(409, code)),
        () => Promise.reject(new AnswerError(409, code)),
      );
      const runner = createRunner();
      await runner.run();
      expect(await store.release('B', EVENT, state)).toBe(0);
      expect(await store.release('A', EVENT, state)).toBe(1);
      await runner.retryNow();
      expect((await only('A', EVENT)).state).toBe('uploaded');
      expect((await only('A', OTHER_EVENT)).state).toBe(state);
    },
  );

  it('a fresh event answer releases a photo stopped at completion back to completion', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.completeScript.push(() => Promise.reject(new AnswerError(403, 'not_member')));
    const runner = createRunner();
    await runner.run();
    expect(await store.releaseLostAccess('A', EVENT)).toBe(1);
    expect(await only()).toMatchObject({
      state: 'uploading',
      step: 'complete',
      stoppedReason: null,
    });
    await runner.retryNow();
    expect(server.count('preflight')).toBe(1);
    expect((await only()).state).toBe('uploaded');
  });

  it('a fresh event answer releases a photo stopped at pre-flight back to pre-flight', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(new AnswerError(404, 'not_found')));
    const runner = createRunner();
    await runner.run();
    expect(await store.releaseLostAccess('A', EVENT)).toBe(1);
    expect(await only()).toMatchObject({ state: 'queued', step: 'preflight' });
    await runner.retryNow();
    expect((await only()).state).toBe('uploaded');
  });

  it('never releases a photo stopped for a reason that does not clear', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(() => Promise.reject(new AnswerError(422, 'event_full')));
    await createRunner().run();
    expect(await store.releaseLostAccess('A', EVENT)).toBe(0);
    expect((await only()).state).toBe('stopped');
  });

  it('stops a photo whose prepared file is gone instead of retrying for ever', async () => {
    await store.enqueue('A', EVENT, SUB, photo);
    server.preflightScript.push(async () => {
      disk.delete('A/item-1/upload.jpg');
      return server.realPreflight('A', (server.calls[0] as { body: PreflightUploadRequest }).body);
    });
    await createRunner().run();
    expect(await only()).toMatchObject({ state: 'stopped', stoppedReason: 'invalid_request' });
  });
});
