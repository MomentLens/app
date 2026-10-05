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
