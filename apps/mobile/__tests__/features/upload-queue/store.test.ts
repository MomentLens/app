import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { refreshMediaStatus } from '@/features/my-media/status';

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
    database.exec(
      'DROP TABLE capture_journal; DROP TABLE gps_reading; DROP TABLE qr_scan; PRAGMA user_version = 1;',
    );
    const upgraded = createStore();
    await upgraded.initialize();
    expect(await upgraded.listForEvent('A', 'event')).toHaveLength(1);
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('capture_journal', 'gps_reading', 'qr_scan') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'capture_journal' }, { name: 'gps_reading' }, { name: 'qr_scan' }]);
  });
  it('gives account B no rows or counts belonging to A', async () => {
    await store.enqueue('A', 'event', 'sub', photo);
    expect(await store.listForEvent('B', 'event')).toEqual([]);
    expect(queueCounts(await store.listForEvent('B', 'event'))).toEqual({
      queued: 0,
      waitingAlbum: 0,
      waitingVerification: 0,
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

describe('S-17 four stored queue counts', () => {
  it('counts each state once and excludes retained, stopped and Local Only rows', async () => {
    for (const state of [
      'queued',
      'waiting_album',
      'waiting_verification',
      'uploading',
      'uploaded',
      'published',
      'stopped',
      'local_only',
    ] as const) {
      const row = await store.enqueue('A', 'event', 'sub', photo);
      await store.update('A', row.id, {
        state,
        ...(state === 'uploaded' || state === 'published' ? { mediaId: 'media-' + state } : {}),
        ...(state === 'stopped' ? { stoppedReason: 'event_full' as const } : {}),
      });
    }
    await store.enqueue('B', 'event', 'sub', photo);
    await store.enqueue('A', 'other-event', 'sub', photo);
    const expected = { queued: 1, waitingAlbum: 1, waitingVerification: 1, uploading: 1 };
    expect(queueCounts(await store.listForEvent('A', 'event'))).toEqual(expected);
    expect(queueCounts(await createStore().listForEvent('A', 'event'))).toEqual(expected);
    expect(queueCounts(await store.listForEvent('B', 'event'))).toEqual({
      ...expected,
      waitingAlbum: 0,
      waitingVerification: 0,
      uploading: 0,
    });
    expect(queueCounts(await store.listForEvent('A', 'other-event'))).toEqual({
      ...expected,
      waitingAlbum: 0,
      waitingVerification: 0,
      uploading: 0,
    });
    expect(queueCounts(await store.listForEvent('B', 'other-event'))).toEqual({
      queued: 0,
      waitingAlbum: 0,
      waitingVerification: 0,
      uploading: 0,
    });
  });
});

describe('status recovery transactions', () => {
  const mediaId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  async function seed(count: number) {
    await store.initialize();
    const insert = database.prepare(
      "INSERT INTO queue_item (id,userId,eventId,subEventId,thumbnailPath,createdAt,state,step,mediaId) VALUES (?,'A','event','sub',?,?,'uploaded','complete',?)",
    );
    for (let i = 0; i < count; i++) insert.run(`row-${i}`, `thumb-${i}`, i, mediaId(i));
  }
  it('recovers 2000 photos with one notification and 40 bounded SQL updates', async () => {
    await seed(2000);
    const changed = jest.fn();
    store.subscribe(changed);
    const read = jest.spyOn(store, 'listForEvent');
    const writes: number[] = [];
    const original = database.prepare.bind(database);
    jest.spyOn(database, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('UPDATE queue_item')) writes.push((sql.match(/\?/g) ?? []).length);
      return original(sql);
    });
    const request = jest.fn(async (ids: string[]) => ({
      statuses: ids.map((id) => ({ mediaId: id, status: 'published' as const })),
    }));
    await refreshMediaStatus(store, 'A', 'event', true, request, () => true);
    expect(request).toHaveBeenCalledTimes(40);
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(40);
    expect(Math.max(...writes)).toBeLessThanOrEqual(52);
    expect((await store.listForEvent('A', 'event')).every((row) => row.state === 'published')).toBe(
      true,
    );
  });
  it('applies received statuses when the next network batch fails', async () => {
    await seed(51);
    const request = jest.fn(async (ids: string[]) => ({
      statuses: ids.map((id) => ({ mediaId: id, status: 'published' as const })),
    }));
    request
      .mockReset()
      .mockImplementationOnce(async (ids) => ({
        statuses: ids.map((id) => ({ mediaId: id, status: 'published' as const })),
      }))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(
      refreshMediaStatus(store, 'A', 'event', true, request, () => true),
    ).rejects.toThrow('offline');
    expect(
      (await store.listForEvent('A', 'event')).filter((row) => row.state === 'published'),
    ).toHaveLength(50);
  });
  it('scopes changes to finished rows in the account and event, and removes deleted files', async () => {
    await seed(4);
    database.exec(
      "UPDATE queue_item SET userId = 'B' WHERE id = 'row-1'; UPDATE queue_item SET eventId = 'other' WHERE id = 'row-2'; UPDATE queue_item SET state = 'uploading' WHERE id = 'row-3'",
    );
    files.add('thumb-0');
    await store.reconcileMedia(
      'A',
      'event',
      [0, 1, 2, 3].map((i) => ({ mediaId: mediaId(i), status: 'deleted' })),
      () => true,
    );
    expect(database.prepare('SELECT count(*) AS total FROM queue_item').get()).toEqual({
      total: 3,
    });
    expect(files.has('thumb-0')).toBe(false);
  });
  it('rolls back earlier deletions when a later SQL write fails, retaining files for retry', async () => {
    await seed(2);
    files.add('thumb-0');
    database.exec(
      "CREATE TRIGGER fail_publish BEFORE UPDATE ON queue_item WHEN NEW.state = 'published' BEGIN SELECT RAISE(ABORT, 'disk write failed'); END",
    );
    const changed = jest.fn();
    store.subscribe(changed);
    await expect(
      store.reconcileMedia(
        'A',
        'event',
        [
          { mediaId: mediaId(0), status: 'deleted' },
          { mediaId: mediaId(1), status: 'published' },
        ],
        () => true,
      ),
    ).rejects.toThrow('disk write failed');
    expect(await store.listForEvent('A', 'event')).toHaveLength(2);
    expect(files.has('thumb-0')).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });
  it('rolls back SQL and retains files when the account changes before commit', async () => {
    await seed(1);
    files.add('thumb-0');
    const changed = jest.fn();
    store.subscribe(changed);
    let checks = 0;
    await store.reconcileMedia(
      'A',
      'event',
      [{ mediaId: mediaId(0), status: 'deleted' }],
      () => ++checks < 3,
    );
    expect(await store.listForEvent('A', 'event')).toHaveLength(1);
    expect(files.has('thumb-0')).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });
});
