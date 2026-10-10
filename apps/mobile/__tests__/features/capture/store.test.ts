import { beforeEach, describe, expect, it } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore, type QueueDatabase, type QueueFiles } from '@/features/upload-queue/store';
import { CaptureStore, type CaptureFiles } from '@/features/capture/capture-store';

let database: DatabaseSync;
let queue: QueueStore;
let captures: CaptureStore;
let disk: Set<string>;
beforeEach(() => {
  database = new DatabaseSync(':memory:');
  disk = new Set();
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
    copy: async () => {
      throw new Error('Capture must not enqueue through picker copy');
    },
    uri: (path) => `file:///documents/${path}`,
    delete: async (path) => {
      disk.delete(path);
    },
    list: async () => [...disk],
  };
  const cameraFiles: CaptureFiles = {
    original: async (owner, id) => {
      const path = `${owner}/${id}/original.jpg`;
      disk.add(path);
      return path;
    },
    thumbnail: async (path) => {
      const thumb = path.replace('original.jpg', 'thumb.webp');
      disk.add(thumb);
      return thumb;
    },
  };
  queue = new QueueStore(db, files, () => 'unused');
  captures = new CaptureStore(queue, cameraFiles);
});
const shot = {
  userId: 'A',
  eventId: 'event',
  subEventId: 'sub',
  capturedAt: '2026-10-10T10:00:00Z',
  mode: 'public' as const,
};
describe('capture journal and atomic handoff', () => {
  it('retains a failed Public draft without making it eligible for upload', async () => {
    await captures.persist('c1', shot, 'file:///camera.jpg');
    expect(await queue.nextUpload('A', Date.now(), [])).toBeNull();
    expect(await captures.claimGallery('A', 'c1', false)).toBe(true);
    await captures.galleryResult('A', 'c1', false);
    await expect(captures.handoff('A', 'c1')).rejects.toThrow('gallery');
    expect((await captures.list('A', 'event'))[0]?.galleryState).toBe('failed');
  });
  it('never duplicates a handed-off capture after restarting or concurrent handoff', async () => {
    await captures.persist('c1', shot, 'file:///camera.jpg');
    await captures.claimGallery('A', 'c1', false);
    await captures.galleryResult('A', 'c1', true);
    await Promise.all([captures.handoff('A', 'c1'), captures.handoff('A', 'c1')]);
    expect(await queue.listForEvent('A', 'event')).toHaveLength(1);
    await captures.recover();
    await captures.handoff('A', 'c1');
    expect(await queue.listForEvent('A', 'event')).toHaveLength(1);
    expect(await captures.list('A', 'event')).toEqual([]);
  });
  it('rolls back the queue insert if recording the handoff fails', async () => {
    await captures.persist('c1', shot, 'file:///camera.jpg');
    await captures.claimGallery('A', 'c1', false);
    await captures.galleryResult('A', 'c1', true);
    database.exec(
      "CREATE TRIGGER fail_handoff BEFORE UPDATE ON capture_journal WHEN NEW.galleryState = 'handed_off' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(captures.handoff('A', 'c1')).rejects.toThrow('disk full');
    expect(await queue.listForEvent('A', 'event')).toEqual([]);
    expect((await captures.list('A', 'event'))[0]?.galleryState).toBe('saved');
  });
  it('requires explicit retry for a gallery write interrupted by restart', async () => {
    await captures.persist('c1', shot, 'file:///camera.jpg');
    await captures.claimGallery('A', 'c1', false);
    await captures.recover();
    expect((await captures.list('A', 'event'))[0]?.galleryState).toBe('uncertain');
    expect(await captures.claimGallery('A', 'c1', false)).toBe(false);
    expect(await captures.claimGallery('A', 'c1', true)).toBe(true);
  });
  it('keeps other accounts and events out of draft reads and writes', async () => {
    await captures.persist('c1', shot, 'file:///camera.jpg');
    expect(await captures.list('B', 'event')).toEqual([]);
    expect(await captures.list('A', 'other')).toEqual([]);
    expect(await captures.claimGallery('B', 'c1', true)).toBe(false);
    expect(await captures.remove('B', 'c1')).toBe(false);
    await expect(captures.handoff('B', 'c1')).rejects.toThrow();
    await queue.sweep();
    expect(disk.has('A/c1/original.jpg')).toBe(true);
  });
  it('inserts Local Only directly with no intermediate uploadable state', async () => {
    await captures.persist('c1', { ...shot, mode: 'local_only' }, 'file:///camera.jpg');
    expect(await captures.list('A', 'event')).toEqual([]);
    expect((await queue.listForEvent('A', 'event'))[0]?.state).toBe('local_only');
    expect(await queue.nextUpload('A', Date.now(), [])).toBeNull();
  });
});
