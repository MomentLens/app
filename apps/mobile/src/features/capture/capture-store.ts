import type { QueueStore } from '@/features/upload-queue/store';
import type { QueueItem } from '@/features/upload-queue/types';
import type { ShotContext } from './context';

export type GalleryState = 'pending' | 'saving' | 'failed' | 'uncertain' | 'saved' | 'handed_off';
export interface CaptureDraft extends Pick<
  QueueItem,
  | 'id'
  | 'userId'
  | 'eventId'
  | 'subEventId'
  | 'capturedAt'
  | 'createdAt'
  | 'photoPath'
  | 'thumbnailPath'
  | 'photoUri'
  | 'thumbnailUri'
> {
  state: 'capture_draft';
  galleryState: GalleryState;
}
interface JournalRow {
  id: string;
  userId: string;
  eventId: string;
  subEventId: string;
  capturedAt: string;
  createdAt: number;
  photoPath: string;
  thumbnailPath: string | null;
  galleryState: GalleryState;
}
export interface CaptureFiles {
  original(owner: string, id: string, uri: string): Promise<string>;
  thumbnail(original: string): Promise<string>;
}
export const CAPTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS capture_journal (
  id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL, eventId TEXT NOT NULL,
  subEventId TEXT NOT NULL, capturedAt TEXT NOT NULL, createdAt INTEGER NOT NULL,
  photoPath TEXT NOT NULL, thumbnailPath TEXT,
  galleryState TEXT NOT NULL CHECK(galleryState IN ('pending','saving','failed','uncertain','saved','handed_off'))
);
CREATE INDEX IF NOT EXISTS capture_owner_event ON capture_journal(userId,eventId,createdAt);
`;
export class CaptureStore {
  constructor(
    private queue: QueueStore,
    private files: CaptureFiles,
  ) {}
  async persist(id: string, shot: ShotContext, uri: string): Promise<void> {
    await this.queue.captureMutation(async (db) => {
      const photoPath = await this.files.original(shot.userId, id, uri);
      const createdAt = Date.parse(shot.capturedAt);
      if (shot.mode === 'local_only') {
        const thumbnailPath = await this.files.thumbnail(photoPath);
        await db.runAsync(
          `INSERT INTO queue_item (id,userId,eventId,subEventId,photoPath,thumbnailPath,capturedAt,createdAt,state,step) VALUES (?,?,?,?,?,?,?,?,'local_only','prepare')`,
          id,
          shot.userId,
          shot.eventId,
          shot.subEventId,
          photoPath,
          thumbnailPath,
          shot.capturedAt,
          createdAt,
        );
        return;
      }
      // Persist the original first. A thumbnail failure must not lose a Public draft.
      await db.runAsync(
        `INSERT INTO capture_journal (id,userId,eventId,subEventId,photoPath,capturedAt,createdAt,galleryState) VALUES (?,?,?,?,?,?,?,'pending')`,
        id,
        shot.userId,
        shot.eventId,
        shot.subEventId,
        photoPath,
        shot.capturedAt,
        createdAt,
      );
      try {
        const thumb = await this.files.thumbnail(photoPath);
        await db.runAsync(
          'UPDATE capture_journal SET thumbnailPath = ? WHERE userId = ? AND id = ?',
          thumb,
          shot.userId,
          id,
        );
      } catch {
        /* The original previews this draft until handoff retries the thumbnail. */
      }
    });
  }
  async list(owner: string, eventId: string): Promise<CaptureDraft[]> {
    return this.queue.captureRead(async (db, disk) => {
      const rows = await db.getAllAsync<JournalRow>(
        "SELECT * FROM capture_journal WHERE userId = ? AND eventId = ? AND galleryState != 'handed_off' ORDER BY createdAt DESC, id DESC",
        owner,
        eventId,
      );
      return rows.map((row) => ({
        ...row,
        state: 'capture_draft' as const,
        thumbnailPath: row.thumbnailPath ?? row.photoPath,
        photoUri: disk.uri(row.photoPath),
        thumbnailUri: disk.uri(row.thumbnailPath ?? row.photoPath),
      }));
    });
  }
  async recover(): Promise<void> {
    await this.queue.captureMutation(async (db) => {
      await db.runAsync(
        "UPDATE capture_journal SET galleryState = 'uncertain' WHERE galleryState = 'saving'",
      );
    });
  }
  async claimGallery(owner: string, id: string, explicit: boolean): Promise<boolean> {
    return this.queue.captureMutation(async (db) => {
      const result = await db.runAsync(
        `UPDATE capture_journal SET galleryState = 'saving' WHERE userId = ? AND id = ? AND galleryState IN (${explicit ? "'pending','failed','uncertain'" : "'pending'"})`,
        owner,
        id,
      );
      return result.changes === 1;
    });
  }
  async galleryResult(owner: string, id: string, saved: boolean): Promise<void> {
    await this.queue.captureMutation(async (db) => {
      await db.runAsync(
        "UPDATE capture_journal SET galleryState = ? WHERE userId = ? AND id = ? AND galleryState = 'saving'",
        saved ? 'saved' : 'failed',
        owner,
        id,
      );
    });
  }
  // The gallery state the journal holds now, or null when the row is gone.
  async galleryStateOf(owner: string, id: string): Promise<GalleryState | null> {
    return this.queue.captureRead(async (db) => {
      const [row] = await db.getAllAsync<Pick<JournalRow, 'galleryState'>>(
        'SELECT galleryState FROM capture_journal WHERE userId = ? AND id = ?',
        owner,
        id,
      );
      return row?.galleryState ?? null;
    });
  }
  async originalUri(owner: string, id: string): Promise<string> {
    return this.queue.captureRead(async (db, disk) => {
      const [row] = await db.getAllAsync<JournalRow>(
        'SELECT * FROM capture_journal WHERE userId = ? AND id = ?',
        owner,
        id,
      );
      if (!row) throw new Error('The capture is unavailable.');
      return disk.uri(row.photoPath);
    });
  }
  async thumbnailUri(owner: string, id: string): Promise<string> {
    return this.queue.captureRead(async (db, disk) => {
      const [row] = await db.getAllAsync<{ thumbnailPath: string }>(
        "SELECT thumbnailPath FROM queue_item WHERE userId = ? AND id = ? UNION ALL SELECT COALESCE(thumbnailPath,photoPath) AS thumbnailPath FROM capture_journal WHERE userId = ? AND id = ? AND galleryState != 'handed_off'",
        owner,
        id,
        owner,
        id,
      );
      if (!row) throw new Error('The capture is unavailable.');
      return disk.uri(row.thumbnailPath);
    });
  }
  async handoff(owner: string, id: string): Promise<void> {
    await this.queue.captureMutation(async (db) => {
      const [row] = await db.getAllAsync<JournalRow>(
        'SELECT * FROM capture_journal WHERE userId = ? AND id = ?',
        owner,
        id,
      );
      if (!row) throw new Error('The capture is unavailable.');
      if (row.galleryState === 'handed_off') return;
      if (row.galleryState !== 'saved') throw new Error('The gallery save has not succeeded.');
      const thumb = row.thumbnailPath ?? (await this.files.thumbnail(row.photoPath));
      // All writes share the queue's mutation chain. No runner write can enter this transaction.
      await db.execAsync('BEGIN IMMEDIATE');
      try {
        await db.runAsync(
          `INSERT INTO queue_item (id,userId,eventId,subEventId,photoPath,thumbnailPath,capturedAt,createdAt,state,step) VALUES (?,?,?,?,?,?,?,?,'queued','prepare')`,
          id,
          owner,
          row.eventId,
          row.subEventId,
          row.photoPath,
          thumb,
          row.capturedAt,
          row.createdAt,
        );
        await db.runAsync(
          "UPDATE capture_journal SET galleryState = 'handed_off', thumbnailPath = ? WHERE userId = ? AND id = ?",
          thumb,
          owner,
          id,
        );
        await db.execAsync('COMMIT');
      } catch (error) {
        await db.execAsync('ROLLBACK');
        throw error;
      }
    });
  }
  async remove(owner: string, id: string): Promise<boolean> {
    return this.queue.captureMutation(async (db, disk) => {
      const [row] = await db.getAllAsync<JournalRow>(
        "SELECT * FROM capture_journal WHERE userId = ? AND id = ? AND galleryState NOT IN ('saving','handed_off')",
        owner,
        id,
      );
      if (!row) return false;
      await db.runAsync('DELETE FROM capture_journal WHERE userId = ? AND id = ?', owner, id);
      await Promise.allSettled(
        [row.photoPath, row.thumbnailPath]
          .filter((path): path is string => path !== null)
          .map((path) => disk.delete(path)),
      );
      return true;
    });
  }
}
