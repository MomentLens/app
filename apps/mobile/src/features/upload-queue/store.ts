import type { QueueCounts, QueueItem, QueuePatch, QueuePhoto } from './types';

export interface QueueDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export interface QueueFiles {
  copy(
    owner: string,
    id: string,
    uri: string,
  ): Promise<{ photoPath: string; thumbnailPath: string }>;
  delete(path: string): Promise<void>;
  list(): Promise<string[]>;
  uri(path: string): string;
}
const COLUMNS =
  'id, userId, eventId, subEventId, photoPath, thumbnailPath, capturedAt, createdAt, state, step, mediaId, contentHash, retryCount, nextRetryAt, stoppedReason';
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS queue_item (
  id TEXT PRIMARY KEY NOT NULL,
  userId TEXT NOT NULL, eventId TEXT NOT NULL, subEventId TEXT NOT NULL,
  photoPath TEXT, thumbnailPath TEXT NOT NULL, capturedAt TEXT,
  createdAt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','waiting_album','waiting_verification','uploading','uploaded','published','stopped','local_only')),
  step TEXT NOT NULL CHECK(step IN ('prepare','preflight','put_photo','put_thumbnail','complete')),
  mediaId TEXT, contentHash TEXT,
  retryCount INTEGER NOT NULL DEFAULT 0 CHECK(retryCount >= 0), nextRetryAt INTEGER,
  stoppedReason TEXT CHECK(stoppedReason IN ('event_full','too_many_unfinished','sub_event_missing','invalid_request','not_uploader','not_member','not_found')),
  CHECK(state NOT IN ('uploaded','published') OR mediaId IS NOT NULL),
  CHECK(state != 'stopped' OR stoppedReason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS queue_owner_event ON queue_item(userId, eventId, createdAt);
PRAGMA user_version = 1;
`;
type StoredItem = Omit<QueueItem, 'photoUri' | 'thumbnailUri'>;

export class QueueStore {
  private ready: Promise<void> | undefined;
  // Serializes disk and SQL mutations with the startup sweep. A sweep cannot delete a copy
  // between its creation and INSERT, and a late completion cannot restore a deleted item.
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(
    private db: QueueDatabase,
    private files: QueueFiles,
    private makeId: () => string,
  ) {}

  initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = this.db.execAsync(SCHEMA).catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }
  // Deletes files no row references: a copy left by a kill before its INSERT, or a source left by
  // a kill after the completion UPDATE. It runs on the mutation chain, so reads do not wait for it.
  // It never fails. A file it cannot list or delete waits for the next launch, and the queue
  // works meanwhile.
  sweep(): Promise<void> {
    return this.mutate(async () => {
      const rows = await this.db.getAllAsync<Pick<StoredItem, 'photoPath' | 'thumbnailPath'>>(
        'SELECT photoPath, thumbnailPath FROM queue_item',
      );
      const keep = new Set(rows.flatMap((row) => [row.photoPath, row.thumbnailPath]));
      for (const path of await this.files.list()) {
        if (keep.has(path)) continue;
        try {
          await this.files.delete(path);
        } catch {
          // The next launch tries again.
        }
      }
    }).catch(() => undefined);
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      await this.initialize();
      return operation();
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  private hydrate(row: StoredItem): QueueItem {
    return {
      ...row,
      photoUri: row.photoPath ? this.files.uri(row.photoPath) : null,
      thumbnailUri: this.files.uri(row.thumbnailPath),
    };
  }
  async listForEvent(userId: string, eventId: string): Promise<QueueItem[]> {
    await this.initialize();
    const rows = await this.db.getAllAsync<StoredItem>(
      `SELECT ${COLUMNS} FROM queue_item WHERE userId = ? AND eventId = ? ORDER BY createdAt DESC, id DESC`,
      userId,
      eventId,
    );
    return rows.map((row) => this.hydrate(row));
  }
  enqueue(
    userId: string,
    eventId: string,
    subEventId: string,
    photo: QueuePhoto,
  ): Promise<QueueItem> {
    return this.mutate(async () => {
      const id = this.makeId();
      const paths = await this.files.copy(userId, id, photo.uri);
      const createdAt = Date.now();
      try {
        await this.db.runAsync(
          `INSERT INTO queue_item (id,userId,eventId,subEventId,photoPath,thumbnailPath,capturedAt,createdAt,state,step) VALUES (?,?,?,?,?,?,?,?,'queued','prepare')`,
          id,
          userId,
          eventId,
          subEventId,
          paths.photoPath,
          paths.thumbnailPath,
          photo.capturedAt,
          createdAt,
        );
      } catch (error) {
        // A failed cleanup leaves only an orphan, which the next launch sweeps.
        await Promise.allSettled([
          this.files.delete(paths.photoPath),
          this.files.delete(paths.thumbnailPath),
        ]);
        throw error;
      }
      this.changed();
      return this.hydrate({
        id,
        userId,
        eventId,
        subEventId,
        ...paths,
        capturedAt: photo.capturedAt,
        createdAt,
        state: 'queued',
        step: 'prepare',
        mediaId: null,
        contentHash: null,
        retryCount: 0,
        nextRetryAt: null,
        stoppedReason: null,
      });
    });
  }
  remove(userId: string, id: string): Promise<boolean> {
    return this.mutate(async () => {
      const [row] = await this.db.getAllAsync<StoredItem>(
        `SELECT ${COLUMNS} FROM queue_item WHERE userId = ? AND id = ?`,
        userId,
        id,
      );
      if (!row) return false;
      await this.db.runAsync('DELETE FROM queue_item WHERE userId = ? AND id = ?', userId, id);
      this.changed();
      // Delete the row first. A crash or a disk refusal leaves an orphan for the next launch.
      await Promise.allSettled(
        [row.photoPath, row.thumbnailPath]
          .filter((path): path is string => path !== null)
          .map((path) => this.files.delete(path)),
      );
      return true;
    });
  }
  update(userId: string, id: string, patch: QueuePatch): Promise<boolean> {
    return this.mutate(async () => {
      const allowed = [
        'state',
        'step',
        'mediaId',
        'contentHash',
        'retryCount',
        'nextRetryAt',
        'stoppedReason',
      ] as const;
      const entries = allowed
        .filter((key) => patch[key] !== undefined)
        .map((key) => [key, patch[key]!] as const);
      if (entries.length === 0) return false;
      const finished = patch.state === 'uploaded' || patch.state === 'published';
      const [row] = finished
        ? await this.db.getAllAsync<StoredItem>(
            `SELECT ${COLUMNS} FROM queue_item WHERE userId = ? AND id = ?`,
            userId,
            id,
          )
        : [];
      const set = entries.map(([key]) => `${key} = ?`).join(',');
      const result = await this.db.runAsync(
        `UPDATE queue_item SET ${set}${finished ? ',photoPath = NULL' : ''} WHERE userId = ? AND id = ?`,
        ...entries.map(([, value]) => value),
        userId,
        id,
      );
      if (result.changes) this.changed();
      if (finished && row?.photoPath) await Promise.allSettled([this.files.delete(row.photoPath)]);
      return result.changes > 0;
    });
  }
}
export function queueCounts(rows: readonly QueueItem[]): QueueCounts {
  return {
    waiting: rows.filter((row) =>
      ['queued', 'waiting_album', 'waiting_verification'].includes(row.state),
    ).length,
    uploading: rows.filter((row) => row.state === 'uploading').length,
  };
}
