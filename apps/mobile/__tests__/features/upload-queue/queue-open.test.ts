import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { dehydrate, hydrate, QueryClient } from '@tanstack/react-query';
import { GpsReadings } from '@/features/verification/readings';

import type * as AuthModule from '@/stores/auth';
import type * as QueueModule from '@/features/upload-queue/queue';
import type { QueueDatabase } from '@/features/upload-queue/store';

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const SUB = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const MEDIA = '11111111-1111-4111-8111-111111111111';
const OTHER_SUB = '11111111-1111-4111-8111-111111111112';
const mockQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// The queue's database, opened on node's SQLite as store.test.ts does.
let database: DatabaseSync;
function adapt(): QueueDatabase {
  return {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...params) => ({
      changes: Number(database.prepare(sql).run(...params).changes),
    }),
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      database.prepare(sql).all(...params) as T[],
  };
}

const mockExclude = jest.fn<() => Promise<void>>();
const mockOpenDatabase = jest.fn(async (_name: string) => adapt());
const mockPreflight = jest.fn(async () => ({
  mediaId: MEDIA,
  photoUploadUrl: 'https://r2.example.test/photo?sig=1',
  thumbnailUploadUrl: 'https://r2.example.test/thumb?sig=1',
}));
const mockComplete = jest.fn(async () => ({ status: 'completed' as const }));

jest.mock('../../../modules/local-media', () => ({ excludeMediaFromBackup: () => mockExclude() }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: (name: string) => mockOpenDatabase(name) }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists() {
      return true;
    }
    upload() {
      return Promise.resolve({ status: 200 });
    }
  },
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
}));
jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
  getNetworkStateAsync: async () => ({ type: 'WIFI' }),
}));
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getBoolean: () => undefined,
    addOnValueChangedListener: () => ({ remove: () => undefined }),
  }),
}));
jest.mock('@/lib/query-client', () => ({
  queryClient: mockQueryClient,
}));
jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  },
}));
jest.mock('@/lib/api', () => ({ preflightUpload: mockPreflight, completeUpload: mockComplete }));
jest.mock('@/features/event-shell/use-event', () => ({
  eventQueryKey: (id: string) => ['event', id],
  recheckEvent: () => undefined,
}));
jest.mock('@/features/upload-queue/prepare', () => ({
  prepareUpload: async (sourcePath: string) => ({
    photoPath: sourcePath.replace(/[^/]+$/, 'upload.jpg'),
    contentHash: 'a'.repeat(64),
  }),
}));
jest.mock('@/features/upload-queue/files', () => ({
  queueFiles: {
    copy: async (owner: string, id: string) => ({
      photoPath: `${owner}/${id}/source.jpg`,
      thumbnailPath: `${owner}/${id}/thumb.webp`,
    }),
    delete: async () => undefined,
    list: async () => [],
    uri: (path: string) => `file:///documents/upload-queue/${path}`,
  },
}));
jest.mock('@/features/capture/capture-files', () => ({
  captureFiles: { original: async () => 'unused', thumbnail: async () => 'unused' },
}));

let queue: typeof QueueModule;
let auth: typeof AuthModule;
beforeEach(() => {
  database = new DatabaseSync(':memory:');
  mockExclude.mockReset();
  mockExclude.mockRejectedValue(new Error('Backup exclusion failed'));
  mockPreflight.mockClear();
  mockComplete.mockClear();
  (
    globalThis as typeof globalThis & { __momentlensStopUploads?: () => void }
  ).__momentlensStopUploads?.();
  mockQueryClient.clear();
  // A fresh module graph per test, so the queue's open promise starts unopened each time.
  jest.isolateModules(() => {
    queue = jest.requireActual<typeof QueueModule>('@/features/upload-queue/queue');
    auth = jest.requireActual<typeof AuthModule>('@/stores/auth');
  });
  auth.useAuthStore.setState({ status: 'signedIn', userId: 'A' });
});

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The queue never reached the expected state');
}

describe('S-15 queue lifecycle', () => {
  it('recovers a kill after storing a QR scan and before releasing its waiting photo', async () => {
    const store = await queue.getQueue();
    const item = await store.enqueue('A', EVENT, SUB, {
      uri: 'file:///photo.jpg',
      capturedAt: null,
    });
    await store.update('A', item.id, { state: 'waiting_verification' });
    await (
      await queue.getQrScans()
    ).save(
      'A',
      EVENT,
      {
        kind: 'qr',
        version: 1,
        venueId: EVENT,
        secret: 'a'.repeat(64),
        recordedAt: '2026-10-11T12:30:00.000Z',
      },
      [
        {
          id: SUB,
          name: 'Mehndi',
          description: null,
          startsAt: '2026-10-11T12:00:00.000Z',
          endsAt: '2026-10-11T13:00:00.000Z',
          verificationRadiusM: 200,
          venue: { id: EVENT, name: 'Hall', lat: 31, lng: 74 },
        },
      ],
    );
    queue.startUploads();
    await until(async () => (await store.listForEvent('A', EVENT))[0]?.state === 'uploaded');
    expect(mockPreflight).toHaveBeenCalledWith(
      'A',
      EVENT,
      expect.objectContaining({
        verifications: [expect.objectContaining({ kind: 'qr', venueId: EVENT })],
      }),
      expect.any(AbortSignal),
    );
    expect(await (await queue.getQrScans()).list('A', EVENT)).toEqual([]);
  });
  it('recovers a kill after storing a fix but before releasing its waiting photo', async () => {
    const store = await queue.getQueue();
    const item = await store.enqueue('A', EVENT, SUB, {
      uri: 'file:///photo.jpg',
      capturedAt: null,
    });
    await store.update('A', item.id, { state: 'waiting_verification' });
    await new GpsReadings(store).save(
      'A',
      EVENT,
      [
        {
          subEventId: SUB,
          lat: 31,
          lng: 74,
          accuracyM: 10,
          recordedAt: '2026-10-11T12:30:00.000Z',
        },
      ],
      [SUB],
    );
    queue.startUploads();
    await until(async () => (await store.listForEvent('A', EVENT))[0]?.state === 'uploaded');
    expect(mockPreflight).toHaveBeenCalledWith(
      'A',
      EVENT,
      expect.objectContaining({
        verifications: [expect.objectContaining({ kind: 'gps', subEventId: SUB })],
      }),
      expect.any(AbortSignal),
    );
    expect(await new GpsReadings(store).list('A', EVENT)).toEqual([]);
  });

  it("releases only a fresh event answer's sub-events without clearing another photo backoff", async () => {
    const store = await queue.getQueue();
    const first = await store.enqueue('A', EVENT, SUB, {
      uri: 'file:///first.jpg',
      capturedAt: null,
    });
    const second = await store.enqueue('A', EVENT, OTHER_SUB, {
      uri: 'file:///second.jpg',
      capturedAt: null,
    });
    const backingOff = await store.enqueue('A', 'another-event', SUB, {
      uri: 'file:///third.jpg',
      capturedAt: null,
    });
    for (const item of [first, second])
      await store.update('A', item.id, { state: 'waiting_verification' });
    queue.startUploads();
    await queue.runUploads();
    await store.update('A', backingOff.id, {
      state: 'queued',
      step: 'preflight',
      nextRetryAt: Date.now() + 300_000,
      retryCount: 6,
    });
    const due = (await store.listForEvent('A', 'another-event'))[0]!.nextRetryAt;
    await mockQueryClient.fetchQuery({
      queryKey: ['event', EVENT],
      queryFn: async () => ({ verification: { everySubEvent: false, subEventIds: [SUB] } }),
    });
    await until(async () =>
      (await store.listForEvent('A', EVENT)).some(
        (item) => item.id === first.id && item.state === 'uploaded',
      ),
    );
    expect(await store.listForEvent('A', EVENT)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: second.id, state: 'waiting_verification' }),
      ]),
    );
    expect(await store.listForEvent('A', 'another-event')).toMatchObject([
      { nextRetryAt: due, retryCount: 6 },
    ]);
  });

  it('releases every waiting sub-event after the server reports a manual check-in', async () => {
    const store = await queue.getQueue();
    for (const subEventId of [SUB, OTHER_SUB]) {
      const item = await store.enqueue('A', EVENT, subEventId, {
        uri: 'file:///photo.jpg',
        capturedAt: null,
      });
      await store.update('A', item.id, { state: 'waiting_verification' });
    }
    queue.startUploads();
    await mockQueryClient.fetchQuery({
      queryKey: ['event', EVENT],
      queryFn: async () => ({ verification: { everySubEvent: true, subEventIds: [] } }),
    });
    await until(async () =>
      (await store.listForEvent('A', EVENT)).every((item) => item.state === 'uploaded'),
    );
  });
});

// Only an answer the API sent releases waiting_album photos. A copy restored from disk, seeded from
// the Events list or written by the app releases nothing (arch §4.3, D-161).
describe('S-31 album release', () => {
  const OPEN = { event: { id: EVENT, albumOpen: true } };
  async function waiting() {
    const store = await queue.getQueue();
    const item = await store.enqueue('A', EVENT, SUB, {
      uri: 'file:///photo.jpg',
      capturedAt: null,
    });
    await store.update('A', item.id, { state: 'waiting_album' });
    return { store, item };
  }
  async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('releases on a fetched event answer that shows the album open', async () => {
    const { store } = await waiting();
    queue.startUploads();
    await queue.runUploads();
    await mockQueryClient.fetchQuery({ queryKey: ['event', EVENT], queryFn: async () => OPEN });
    await until(async () =>
      (await store.listForEvent('A', EVENT)).every((item) => item.state === 'uploaded'),
    );
  });

  it('releases on a fetched Events list that shows the album open', async () => {
    const { store } = await waiting();
    queue.startUploads();
    await queue.runUploads();
    await mockQueryClient.fetchQuery({
      queryKey: ['events'],
      queryFn: async () => ({ events: [{ id: EVENT, albumOpen: true }], joinRequests: [] }),
    });
    await until(async () =>
      (await store.listForEvent('A', EVENT)).every((item) => item.state === 'uploaded'),
    );
  });

  it('releases nothing from a closed, restored, seeded or written copy', async () => {
    const { store } = await waiting();
    queue.startUploads();
    await queue.runUploads();
    // A fetched answer with the album closed.
    await mockQueryClient.fetchQuery({
      queryKey: ['event', EVENT],
      queryFn: async () => ({ event: { id: EVENT, albumOpen: false } }),
    });
    // A copy restored from disk, as the persister restores one.
    const saved = new QueryClient();
    saved.setQueryData(['event', EVENT], OPEN);
    saved.setQueryData(['events'], { events: [{ id: EVENT, albumOpen: true }], joinRequests: [] });
    mockQueryClient.clear();
    hydrate(mockQueryClient, dehydrate(saved));
    // A copy seeded from the Events list, as useEvent seeds one.
    mockQueryClient.removeQueries({ queryKey: ['event', EVENT] });
    await mockQueryClient.ensureQueryData({
      queryKey: ['event', EVENT],
      queryFn: async () => {
        throw new Error('A seeded copy is never fetched here');
      },
      initialData: OPEN,
    });
    // A copy the app wrote, such as the Admin's own PUT answer.
    mockQueryClient.setQueryData(['event', EVENT], OPEN);
    await settle();
    expect(await store.listForEvent('A', EVENT)).toMatchObject([{ state: 'waiting_album' }]);
    expect(mockPreflight).not.toHaveBeenCalled();
    saved.clear();
  });

  it('releases only the signed-in account', async () => {
    const { store } = await waiting();
    const other = await store.enqueue('B', EVENT, SUB, { uri: 'file:///b.jpg', capturedAt: null });
    await store.update('B', other.id, { state: 'waiting_album' });
    queue.startUploads();
    await queue.runUploads();
    await mockQueryClient.fetchQuery({ queryKey: ['event', EVENT], queryFn: async () => OPEN });
    await until(async () =>
      (await store.listForEvent('A', EVENT)).every((item) => item.state === 'uploaded'),
    );
    expect(await store.listForEvent('B', EVENT)).toMatchObject([{ state: 'waiting_album' }]);
  });

  it('releases a photo refused while the album opened during its pre-flight', async () => {
    const store = await queue.getQueue();
    await store.enqueue('A', EVENT, SUB, { uri: 'file:///photo.jpg', capturedAt: null });
    mockPreflight.mockImplementationOnce(async () => {
      await mockQueryClient.fetchQuery({ queryKey: ['event', EVENT], queryFn: async () => OPEN });
      throw Object.assign(new Error('album closed'), { status: 409, code: 'album_closed' });
    });
    queue.startUploads();
    await queue.runUploads();
    await until(async () =>
      (await store.listForEvent('A', EVENT)).every((item) => item.state === 'uploaded'),
    );
    expect(mockPreflight).toHaveBeenCalledTimes(2);
  });
});

describe('a failed backup exclusion', () => {
  it('does not block the queue from opening or its reads', async () => {
    await expect(queue.getQueue()).resolves.toBeDefined();
    expect(await queue.listForEvent('A', EVENT)).toEqual([]);
  });

  it('does not block a Public photo from uploading', async () => {
    await queue.enqueue('A', EVENT, SUB, { uri: 'file:///picker/photo.jpg', capturedAt: null });
    await queue.runUploads();
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(await queue.listForEvent('A', EVENT)).toMatchObject([
      { state: 'uploaded', mediaId: MEDIA },
    ]);
  });
});

afterAll(() => {
  (
    globalThis as typeof globalThis & { __momentlensStopUploads?: () => void }
  ).__momentlensStopUploads?.();
  mockQueryClient.clear();
});
