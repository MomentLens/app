import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';

import type * as AuthModule from '@/stores/auth';
import type * as QueueModule from '@/features/upload-queue/queue';
import type { QueueDatabase } from '@/features/upload-queue/store';

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const SUB = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const MEDIA = '11111111-1111-4111-8111-111111111111';

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
  queryClient: { getQueryCache: () => ({ subscribe: () => () => undefined }) },
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
  // A fresh module graph per test, so the queue's open promise starts unopened each time.
  jest.isolateModules(() => {
    queue = jest.requireActual<typeof QueueModule>('@/features/upload-queue/queue');
    auth = jest.requireActual<typeof AuthModule>('@/stores/auth');
  });
  auth.useAuthStore.setState({ status: 'signedIn', userId: 'A' });
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
