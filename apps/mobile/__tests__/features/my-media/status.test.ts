import { describe, expect, it, jest } from '@jest/globals';
import type { QueueStore } from '@/features/upload-queue/store';
import type { QueueItem } from '@/features/upload-queue/types';
import { refreshMediaStatus } from '@/features/my-media/status';

// The API's ids are UUIDs, answered in lower case.
const media = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const items = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `local-${i}`,
        mediaId: media(i),
        state: 'uploaded',
        userId: 'A',
        eventId: 'event',
      }) as QueueItem,
  );
function fake(rows: QueueItem[]) {
  const update = jest.fn(async () => true);
  const remove = jest.fn(async () => true);
  const listForEvent = jest.fn(async () => rows);
  return {
    store: { update, remove, listForEvent } as unknown as QueueStore,
    update,
    remove,
    listForEvent,
  };
}
describe('publish metadata refresh', () => {
  it('batches 51 ids as 50 and 1 without sending local files', async () => {
    const { store, listForEvent } = fake(items(51));
    const read = jest.fn(async (_ids: string[]) => ({ statuses: [] }));
    await refreshMediaStatus(store, 'A', 'event', false, read, () => true);
    expect(listForEvent).toHaveBeenCalledWith('A', 'event');
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([50, 1]);
  });
  it('asks about published photos only on pull to refresh', async () => {
    const rows = items(2);
    rows[1]!.state = 'published';
    const { store } = fake(rows);
    const read = jest.fn(async (_ids: string[]) => ({ statuses: [] }));
    await refreshMediaStatus(store, 'A', 'event', false, read, () => true);
    expect(read).toHaveBeenLastCalledWith([media(0)]);
    await refreshMediaStatus(store, 'A', 'event', true, read, () => true);
    expect(read).toHaveBeenLastCalledWith([media(0), media(1)]);
  });
  it('leaves omitted ids alone and ignores ids outside the batch', async () => {
    const { store, update, remove } = fake(items(1));
    await refreshMediaStatus(
      store,
      'A',
      'event',
      false,
      async () => ({ statuses: [{ mediaId: 'foreign', status: 'published' }] }),
      () => true,
    );
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('removes a deleted photo and marks publication only from the server answer', async () => {
    const { store, update, remove } = fake(items(3));
    await refreshMediaStatus(
      store,
      'A',
      'event',
      false,
      async () => ({
        statuses: [
          { mediaId: media(0), status: 'deleted' },
          { mediaId: media(1), status: 'published' },
          { mediaId: media(2), status: 'processing' },
        ],
      }),
      () => true,
    );
    expect(remove).toHaveBeenCalledWith('A', 'local-0');
    expect(update.mock.calls).toEqual([['A', 'local-1', { state: 'published' }]]);
  });
  it('writes nothing when every answer matches the local state', async () => {
    const rows = items(2);
    rows[1]!.state = 'published';
    const { store, update, remove } = fake(rows);
    await refreshMediaStatus(
      store,
      'A',
      'event',
      true,
      async () => ({
        statuses: [
          { mediaId: media(0), status: 'processing' },
          { mediaId: media(1), status: 'published' },
        ],
      }),
      () => true,
    );
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('moves a published photo back to processing when the worker unpublished it (D-108)', async () => {
    const rows = items(1);
    rows[0]!.state = 'published';
    const { store, update } = fake(rows);
    await refreshMediaStatus(
      store,
      'A',
      'event',
      true,
      async () => ({ statuses: [{ mediaId: media(0), status: 'processing' }] }),
      () => true,
    );
    expect(update).toHaveBeenCalledWith('A', 'local-0', { state: 'uploaded' });
  });
  it('leaves a malformed id out of the batch and matches ids in any case', async () => {
    const rows = items(2);
    rows[0]!.mediaId = 'not-a-uuid';
    rows[1]!.mediaId = media(1).toUpperCase();
    const { store, update } = fake(rows);
    const read = jest.fn(async (_ids: string[]) => ({
      statuses: [{ mediaId: media(1), status: 'published' as const }],
    }));
    await refreshMediaStatus(store, 'A', 'event', false, read, () => true);
    expect(read.mock.calls).toEqual([[[media(1)]]]);
    expect(update.mock.calls).toEqual([['A', 'local-1', { state: 'published' }]]);
  });
  it('discards a late response after switching accounts', async () => {
    const { store, update, remove } = fake(items(1));
    let current = true;
    await refreshMediaStatus(
      store,
      'A',
      'event',
      false,
      async () => {
        current = false;
        return { statuses: [{ mediaId: media(0), status: 'deleted' }] };
      },
      () => current,
    );
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('sends no request for an empty queue', async () => {
    const { store } = fake([]);
    const read = jest.fn(async () => ({ statuses: [] }));
    await refreshMediaStatus(store, 'A', 'event', false, read, () => true);
    expect(read).not.toHaveBeenCalled();
  });
});
