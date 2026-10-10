import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';

import {
  QueueStore,
  queueCounts,
  type QueueDatabase,
  type QueueFiles,
} from '@/features/upload-queue/store';

let nextId = 0;
let database: DatabaseSync;
let files: Set<string>;
let store: QueueStore;
function createStore(overrides: Partial<QueueFiles> = {}) {
  const db: QueueDatabase = {
    execAsync: async (sql) => {
      database.exec(sql);
    },
    runAsync: async (sql, ...params) => {
      const result = database.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    getAllAsync: async <T>(sql: string, ...params: (string | number | null)[]) =>
      database.prepare(sql).all(...params) as T[],
  };
  const disk: QueueFiles = {
    copy: async (owner, id) => {
      const photoPath = `${owner}/${id}/source.jpg`;
      const thumbnailPath = `${owner}/${id}/thumb.webp`;
      files.add(photoPath);
      files.add(thumbnailPath);
      return { photoPath, thumbnailPath };
    },
    delete: async (path) => {
      files.delete(path);
    },
    list: async () => [...files],
    uri: (path) => `file:///documents/queue/${path}`,
    ...overrides,
  };
  return new QueueStore(db, disk, () => `item-${++nextId}`);
}
beforeEach(() => {
  database = new DatabaseSync(':memory:');
  files = new Set();
  nextId = 0;
  store = createStore();
});
const photo = { uri: 'file:///picker/photo.jpg', capturedAt: null };

describe('account-owned durable queue', () => {
  it('migrates a version-1 queue without losing existing photos', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    database.exec('DROP TABLE capture_journal; PRAGMA user_version = 1;');
    const upgraded = createStore();
    await upgraded.initialize();
    expect(await upgraded.listForEvent('A', 'event')).toHaveLength(1);
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
  });
  it('gives account B no rows or counts belonging to A', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    expect(await store.listForEvent('B', 'event')).toEqual([]);
    expect(queueCounts(await store.listForEvent('B', 'event'))).toEqual({
      waiting: 0,
      uploading: 0,
    });
    expect(await store.remove('B', 'item-1')).toBe(false);
    expect(await store.update('B', 'item-1', { state: 'published', mediaId: 'media' })).toBe(false);
    expect(await store.listForEvent('A', 'event')).toHaveLength(1);
    expect(files.size).toBe(2);
  });
  it('keeps items when the store restarts and keeps other events separate', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    store = createStore();
    await store.initialize();
    expect(await store.listForEvent('A', 'event')).toHaveLength(1);
    expect(await store.listForEvent('A', 'other')).toEqual([]);
    expect(files.size).toBe(2);
  });
  it('sweeps files without rows on launch, retaining both accounts files', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.enqueue('B', 'event', 'sub', photo);
    files.add('A/orphan/source.jpg');
    files.add('A/orphan/thumb.webp');
    await createStore().sweep();
    expect([...files]).toHaveLength(4);
    expect(files.has('A/orphan/source.jpg')).toBe(false);
  });
  it('opens the queue when the sweep cannot delete a file, and deletes the rest', async () => {
    files.add('A/stuck/source.jpg');
    files.add('A/orphan/source.jpg');
    const restarted = createStore({
      delete: async (path) => {
        if (path.startsWith('A/stuck/')) throw new Error('Invalid queue file path');
        files.delete(path);
      },
    });
    await expect(restarted.sweep()).resolves.toBeUndefined();
    expect([...files]).toEqual(['A/stuck/source.jpg']);
    await restarted.enqueue('A', 'event', 'sub', photo);
    expect(await restarted.listForEvent('A', 'event')).toHaveLength(1);
  });
  it('opens the queue when the sweep cannot list the directory', async () => {
    const restarted = createStore({ list: () => Promise.reject(new Error('unreadable')) });
    await expect(restarted.sweep()).resolves.toBeUndefined();
    await restarted.enqueue('A', 'event', 'sub', photo);
    expect(await restarted.listForEvent('A', 'event')).toHaveLength(1);
  });
  it('keeps a copy the sweep finds before its INSERT', async () => {
    let release!: () => void;
    const copied = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createStore({
      copy: async (owner, id) => {
        const paths = {
          photoPath: `${owner}/${id}/source.jpg`,
          thumbnailPath: `${owner}/${id}/thumb.webp`,
        };
        files.add(paths.photoPath);
        files.add(paths.thumbnailPath);
        await copied;
        return paths;
      },
    });
    const added = slow.enqueue('A', 'event', 'sub', photo);
    const swept = slow.sweep();
    release();
    await Promise.all([added, swept]);
    expect([...files].sort()).toEqual(['A/item-1/source.jpg', 'A/item-1/thumb.webp']);
  });
  it('keeps the thumbnail and media id after completion and removes the source', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.update('A', 'item-1', { state: 'uploaded', mediaId: 'media', step: 'complete' });
    expect((await store.listForEvent('A', 'event'))[0]).toMatchObject({
      state: 'uploaded',
      mediaId: 'media',
      photoPath: null,
    });
    expect([...files]).toEqual(['A/item-1/thumb.webp']);
  });
  it('does not infer publication from upload completion and rejects published without a media id', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await expect(store.update('A', 'item-1', { state: 'published' })).rejects.toThrow();
    expect((await store.listForEvent('A', 'event'))[0]?.state).toBe('queued');
  });
  it('preserves the completion step across restart after both PUTs', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.update('A', 'item-1', {
      state: 'uploading',
      step: 'complete',
      mediaId: 'media',
      retryCount: 2,
    });
    expect((await createStore().listForEvent('A', 'event'))[0]).toMatchObject({
      state: 'uploading',
      step: 'complete',
      retryCount: 2,
      mediaId: 'media',
    });
  });
  it('removes only the selected local item and its two files', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.enqueue('A', 'event', 'sub', photo);
    expect(await store.remove('A', 'item-1')).toBe(true);
    expect(await store.listForEvent('A', 'event')).toHaveLength(1);
    expect([...files]).toEqual(['A/item-2/source.jpg', 'A/item-2/thumb.webp']);
  });
  it('refuses Delete for an uploading photo in the same statement, keeping its files (D-146)', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.update('A', 'item-1', { state: 'uploading', step: 'put_photo', mediaId: 'media' });
    expect(await store.remove('A', 'item-1')).toBe(false);
    expect((await store.listForEvent('A', 'event'))[0]?.state).toBe('uploading');
    expect(files.size).toBe(2);
  });
  it('lets the runner drop an uploading photo after a duplicate answer', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.update('A', 'item-1', { state: 'uploading', step: 'complete', mediaId: 'media' });
    expect(await store.drop('B', 'item-1')).toBe(false);
    expect(await store.drop('A', 'item-1')).toBe(true);
    expect(await store.listForEvent('A', 'event')).toEqual([]);
    expect(files.size).toBe(0);
  });
  it('writes a guarded update only from the states it names', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    expect(
      await store.update('A', 'item-1', { state: 'uploaded', mediaId: 'm' }, ['uploading']),
    ).toBe(false);
    expect((await store.listForEvent('A', 'event'))[0]).toMatchObject({ state: 'queued' });
    expect(files.size).toBe(2);
  });
  it('picks the oldest due photo for one account and skips the ones already tried', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    await store.enqueue('A', 'other', 'sub', photo);
    await store.enqueue('B', 'event', 'sub', photo);
    await store.update('A', 'item-1', { retryCount: 1, nextRetryAt: 5_000 });
    expect((await store.nextUpload('A', 4_999, []))?.id).toBe('item-2');
    expect((await store.nextUpload('A', 5_000, []))?.id).toBe('item-1');
    expect((await store.nextUpload('A', 5_000, ['item-1']))?.id).toBe('item-2');
    expect(await store.nextUpload('A', 5_000, ['item-1', 'item-2'])).toBeNull();
    expect(await store.nextWake('A', 4_000)).toBe(5_000);
    expect(await store.nextWake('A', 5_000)).toBeNull();
  });
  it('stores the prepared file and hash in one write and then deletes the source', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    files.add('A/item-1/upload.jpg');
    expect(await store.prepared('A', 'item-1', 'A/item-1/upload.jpg', 'f'.repeat(64))).toBe(true);
    expect((await store.listForEvent('A', 'event'))[0]).toMatchObject({
      photoPath: 'A/item-1/upload.jpg',
      contentHash: 'f'.repeat(64),
      step: 'preflight',
      retryCount: 0,
    });
    expect([...files].sort()).toEqual(['A/item-1/thumb.webp', 'A/item-1/upload.jpg']);
    expect(await store.prepared('A', 'item-1', 'A/item-1/upload.jpg', 'e'.repeat(64))).toBe(false);
  });
});
