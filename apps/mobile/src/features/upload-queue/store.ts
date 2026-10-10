import { backoffDelay } from './transitions';
import { CAPTURE_SCHEMA } from '@/features/capture/capture-store';
import type {
  QueueCounts,
  QueueItem,
  QueuePatch,
  QueuePhoto,
  QueueState,
  WaitingState,
} from './types';

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
// True for a queue row `q` whose twin, another photo of the account in the same event with the
// same hash, is still in flight holding a server row. A photo with no media id waits for any such
// twin. One with a media id waits only for an older twin, so two photos never wait for each other.
// A row with no hash yet matches nothing.
const HAS_TWIN = `EXISTS (SELECT 1 FROM queue_item t WHERE t.userId = q.userId AND t.eventId = q.eventId AND t.id != q.id AND t.contentHash = q.contentHash AND t.mediaId IS NOT NULL AND t.state IN ('queued','uploading') AND (q.mediaId IS NULL OR t.createdAt < q.createdAt OR (t.createdAt = q.createdAt AND t.id < q.id)))`;
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
${CAPTURE_SCHEMA}
PRAGMA user_version = 2;
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
        "SELECT photoPath, thumbnailPath FROM queue_item UNION ALL SELECT photoPath, thumbnailPath FROM capture_journal WHERE galleryState != 'handed_off'",
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
  async captureRead<T>(read: (db: QueueDatabase, disk: QueueFiles) => Promise<T>): Promise<T> {
    await this.initialize();
    return read(this.db, this.files);
  }
  captureMutation<T>(write: (db: QueueDatabase, disk: QueueFiles) => Promise<T>): Promise<T> {
    return this.mutate(async () => {
      try {
        return await write(this.db, this.files);
      } finally {
        this.changed();
      }
    });
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
  // My Media's Delete. The DELETE itself refuses an uploading photo, so it cannot race the runner's
  // move to uploading, and one of the two wins (D-146).
  remove(userId: string, id: string): Promise<boolean> {
    return this.deleteRow(userId, id, true);
  }
  // The runner's drop after a duplicate answer, from any state (arch §4).
  drop(userId: string, id: string): Promise<boolean> {
    return this.deleteRow(userId, id, false);
  }
  private deleteRow(userId: string, id: string, refuseUploading: boolean): Promise<boolean> {
    return this.mutate(async () => {
      const [row] = await this.db.getAllAsync<StoredItem>(
        `SELECT ${COLUMNS} FROM queue_item WHERE userId = ? AND id = ?`,
        userId,
        id,
      );
      if (!row) return false;
      const result = await this.db.runAsync(
        `DELETE FROM queue_item WHERE userId = ? AND id = ?${refuseUploading ? " AND state != 'uploading'" : ''}`,
        userId,
        id,
      );
      if (!result.changes) return false;
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
  // With `from`, the write lands only on a photo still in one of those states.
  update(
    userId: string,
    id: string,
    patch: QueuePatch,
    from?: readonly QueueState[],
  ): Promise<boolean> {
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
      const guard = from?.length ? ` AND state IN (${from.map(() => '?').join(',')})` : '';
      const result = await this.db.runAsync(
        `UPDATE queue_item SET ${set}${finished ? ',photoPath = NULL' : ''} WHERE userId = ? AND id = ?${guard}`,
        ...entries.map(([, value]) => value),
        userId,
        id,
        ...(from ?? []),
      );
      if (result.changes) this.changed();
      if (finished && result.changes && row?.photoPath)
        await Promise.allSettled([this.files.delete(row.photoPath)]);
      return result.changes > 0;
    });
  }

  // The runner's next photo for one account: the oldest queued or uploading photo across every
  // event whose backoff ends by `horizon`, leaving out `skip` and any photo waiting for its twin
  // (D-146). Waiting, stopped, finished and Local Only photos never qualify.
  async nextUpload(
    userId: string,
    horizon: number,
    skip: readonly string[],
  ): Promise<QueueItem | null> {
    await this.initialize();
    const skipped = skip.length ? ` AND q.id NOT IN (${skip.map(() => '?').join(',')})` : '';
    const [row] = await this.db.getAllAsync<StoredItem>(
      `SELECT ${COLUMNS} FROM queue_item q WHERE q.userId = ? AND q.state IN ('queued','uploading') AND (q.nextRetryAt IS NULL OR q.nextRetryAt <= ?) AND NOT ${HAS_TWIN}${skipped} ORDER BY q.createdAt ASC, q.id ASC LIMIT 1`,
      userId,
      horizon,
      ...skip,
    );
    return row ? this.hydrate(row) : null;
  }
  // Whether this photo waits for its twin, by the same rule nextUpload leaves it out by.
  async waitsForTwin(userId: string, id: string): Promise<boolean> {
    await this.initialize();
    const rows = await this.db.getAllAsync<{ id: string }>(
      `SELECT q.id FROM queue_item q WHERE q.userId = ? AND q.id = ? AND ${HAS_TWIN}`,
      userId,
      id,
    );
    return rows.length > 0;
  }
  // Foreground, reconnect or a release makes every queued or uploading photo due now. retryCount
  // stays, so the next failure backs off from where it was (D-146).
  clearBackoff(userId: string): Promise<number> {
    return this.mutate(async () => {
      const result = await this.db.runAsync(
        `UPDATE queue_item SET nextRetryAt = NULL WHERE userId = ? AND state IN ('queued','uploading') AND nextRetryAt IS NOT NULL`,
        userId,
      );
      if (result.changes) this.changed();
      return result.changes;
    });
  }
  // When the account's next backoff after `after` ends, or null when nothing is backing off.
  async nextWake(userId: string, after: number): Promise<number | null> {
    await this.initialize();
    const [row] = await this.db.getAllAsync<{ at: number | null }>(
      `SELECT MIN(nextRetryAt) AS at FROM queue_item WHERE userId = ? AND state IN ('queued','uploading') AND nextRetryAt > ?`,
      userId,
      after,
    );
    return row?.at ?? null;
  }
  // A photo left uploading by a kill, or by an account change mid-upload, is queued again at
  // pre-flight, which resumes its row (arch §4). One at step complete stays uploading: both files
  // were sent, so completion runs again and pre-flight never does (D-122). The runner calls this
  // only while no attempt is in flight.
  recover(userId: string): Promise<number> {
    return this.mutate(async () => {
      const result = await this.db.runAsync(
        `UPDATE queue_item SET state = 'queued', step = CASE WHEN step IN ('put_photo','put_thumbnail') THEN 'preflight' ELSE step END WHERE userId = ? AND state = 'uploading' AND step != 'complete'`,
        userId,
      );
      if (result.changes) this.changed();
      return result.changes;
    });
  }
  // Stage 1's result in one write: the photo points at upload.jpg, stores its hash and moves to
  // pre-flight, and only then is the source deleted. Every later attempt sends those bytes, so a
  // kill never changes the hash (arch §4, D-146). False when My Media deleted the photo meanwhile.
  prepared(userId: string, id: string, photoPath: string, contentHash: string): Promise<boolean> {
    return this.mutate(async () => {
      const [row] = await this.db.getAllAsync<Pick<StoredItem, 'photoPath'>>(
        'SELECT photoPath FROM queue_item WHERE userId = ? AND id = ?',
        userId,
        id,
      );
      if (!row) return false;
      const result = await this.db.runAsync(
        `UPDATE queue_item SET photoPath = ?, contentHash = ?, step = 'preflight', retryCount = 0, nextRetryAt = NULL WHERE userId = ? AND id = ? AND state = 'queued' AND step = 'prepare'`,
        photoPath,
        contentHash,
        userId,
        id,
      );
      if (!result.changes) return false;
      this.changed();
      if (row.photoPath && row.photoPath !== photoPath)
        await Promise.allSettled([this.files.delete(row.photoPath)]);
      return true;
    });
  }
  // Moves one event's waiting photos back to queued (D-146).
  release(userId: string, eventId: string, state: WaitingState): Promise<number> {
    return this.mutate(async () => {
      const result = await this.db.runAsync(
        `UPDATE queue_item SET state = 'queued', retryCount = 0, nextRetryAt = NULL WHERE userId = ? AND eventId = ? AND state = ?`,
        userId,
        eventId,
        state,
      );
      if (result.changes) this.changed();
      return result.changes;
    });
  }
  // A fresh 200 from GET /events/{eventId} releases photos stopped by not_member or not_found. One
  // stopped after both files were sent retries completion, and any other goes back through
  // pre-flight (D-146). Each counts the stop as a failure and backs off, so a server whose
  // pre-flight refuses while its event read answers 200 gets one request per backoff, not a loop.
  releaseLostAccess(userId: string, eventId: string, now: number): Promise<number> {
    return this.mutate(async () => {
      const rows = await this.db.getAllAsync<Pick<StoredItem, 'id' | 'retryCount'>>(
        `SELECT id, retryCount FROM queue_item WHERE userId = ? AND eventId = ? AND state = 'stopped' AND stoppedReason IN ('not_member','not_found')`,
        userId,
        eventId,
      );
      let released = 0;
      for (const row of rows) {
        const failures = row.retryCount + 1;
        const result = await this.db.runAsync(
          `UPDATE queue_item SET state = CASE WHEN step = 'complete' THEN 'uploading' ELSE 'queued' END, stoppedReason = NULL, retryCount = ?, nextRetryAt = ? WHERE userId = ? AND id = ? AND state = 'stopped' AND stoppedReason IN ('not_member','not_found')`,
          failures,
          now + backoffDelay(failures),
          userId,
          row.id,
        );
        released += result.changes;
      }
      if (released) this.changed();
      return released;
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
