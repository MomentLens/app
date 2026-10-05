import { MAX_MEDIA_STATUS_BATCH, type MediaStatusResponse } from '@momentlens/shared-types';
import type { QueueStore } from '@/features/upload-queue/store';

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
  const items = (await store.listForEvent(userId, eventId)).filter(
    (item) =>
      item.mediaId !== null && (item.state === 'uploaded' || (all && item.state === 'published')),
  );
  const ids = [...new Set(items.map((item) => item.mediaId!))];
  for (let offset = 0; offset < ids.length; offset += MAX_MEDIA_STATUS_BATCH) {
    if (!isCurrent()) return;
    const batch = ids.slice(offset, offset + MAX_MEDIA_STATUS_BATCH);
    const response = await read(batch);
    if (!isCurrent()) return;
    const targets = new Set(batch);
    for (const result of response.statuses) {
      if (!targets.has(result.mediaId)) continue;
      for (const item of items.filter((row) => row.mediaId === result.mediaId)) {
        if (!isCurrent()) return;
        if (result.status === 'deleted') await store.remove(userId, item.id);
        else
          await store.update(userId, item.id, {
            state: result.status === 'published' ? 'published' : 'uploaded',
          });
      }
    }
  }
}
