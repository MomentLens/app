import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';

import { QueueStore, type QueueDatabase, type QueueFiles } from '@/features/upload-queue/store';

let nextId = 0;
let database: DatabaseSync;
let files: Set<string>;
let store: QueueStore;
function createStore() {
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
  it('gives account B no rows or counts belonging to A', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    expect(await store.listForEvent('B', 'event')).toEqual([]);
    expect(await store.counts('B', 'event')).toEqual({ waiting: 0, uploading: 0 });
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
    await createStore().initialize();
    expect([...files]).toHaveLength(4);
    expect(files.has('A/orphan/source.jpg')).toBe(false);
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
});
