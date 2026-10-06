import {
  MAX_MEDIA_STATUS_BATCH,
  MediaStatusRequest,
  type MediaStatusResponse,
} from '@momentlens/shared-types';
import type { QueueStore } from '@/features/upload-queue/store';

// The API's own rule for one id, so an id it would refuse never joins a batch and fails the
// other 49 with it.
const askable = (id: string) => MediaStatusRequest.safeParse({ mediaIds: [id] }).success;

// The caller supplies a session guard and an abortable request. A response from an old account
// must not change the local queue, even if it arrives after that account signs out.
export async function refreshMediaStatus(
  store: QueueStore,
  userId: string,
  eventId: string,
  all: boolean,
  read: (mediaIds: string[]) => Promise<MediaStatusResponse>,
  isCurrent: () => boolean,
): Promise<void> {
  // The API answers ids in lower case, so they are compared that way.
  const items = (await store.listForEvent(userId, eventId)).flatMap((item) =>
    item.mediaId !== null &&
    askable(item.mediaId) &&
    (item.state === 'uploaded' || (all && item.state === 'published'))
      ? [{ item, mediaId: item.mediaId.toLowerCase() }]
      : [],
  );
  const ids = [...new Set(items.map(({ mediaId }) => mediaId))];
  for (let offset = 0; offset < ids.length; offset += MAX_MEDIA_STATUS_BATCH) {
    if (!isCurrent()) return;
    const batch = ids.slice(offset, offset + MAX_MEDIA_STATUS_BATCH);
    const response = await read(batch);
    if (!isCurrent()) return;
    const targets = new Set(batch);
    for (const result of response.statuses) {
      if (!targets.has(result.mediaId)) continue;
      for (const { item } of items.filter(({ mediaId }) => mediaId === result.mediaId)) {
        if (!isCurrent()) return;
        if (result.status === 'deleted') {
          await store.remove(userId, item.id);
          continue;
        }
        // Each write redraws My Media, so a row whose state already matches is left alone.
        const state = result.status === 'published' ? 'published' : 'uploaded';
        if (item.state !== state) await store.update(userId, item.id, { state });
      }
    }
  }
}

// One Realtime change to a `media` row, as My Media needs it (D-145, D-148). A DELETE carries no
// row: under RLS its old record holds only the id.
export interface MediaChange {
  mediaId: string;
  row: { uploaderUserId: string; processedAt: string | null; deletedAt: string | null } | null;
}

// Applies one Realtime change to this account's queue, the live counterpart of
// refreshMediaStatus. Another uploader's row is skipped without reading the queue, since every
// member's phone hears about every published photo. Each write names the states it may leave, as
// the runner's do, so it never moves a photo the runner still holds anywhere but published.
export async function applyMediaChange(
  store: QueueStore,
  userId: string,
  eventId: string,
  change: MediaChange,
  isCurrent: () => boolean,
): Promise<void> {
  if (change.row !== null && change.row.uploaderUserId.toLowerCase() !== userId.toLowerCase()) {
    return;
  }
  const mediaId = change.mediaId.toLowerCase();
  const items = (await store.listForEvent(userId, eventId)).filter(
    (item) => item.mediaId?.toLowerCase() === mediaId,
  );
  for (const item of items) {
    if (!isCurrent()) return;
    const finished = item.state === 'uploaded' || item.state === 'published';
    if (change.row === null || change.row.deletedAt !== null) {
      if (finished) await store.remove(userId, item.id);
    } else if (change.row.processedAt !== null) {
      // From uploading too: the worker can finish before completion's answer reaches the phone,
      // and the runner's own write after it lands only on a photo still uploading.
      if (item.state !== 'published') {
        await store.update(userId, item.id, { state: 'published' }, ['uploading', 'uploaded']);
      }
    } else if (item.state === 'published') {
      // The worker unpublished it after a job's third failure (D-108).
      await store.update(userId, item.id, { state: 'uploaded' }, ['published']);
    }
  }
}
