import { randomUUID } from 'expo-crypto';
import { openDatabaseAsync } from 'expo-sqlite';

import { queueFiles } from './files';
import { QueueStore } from './store';
import type { QueuePatch, QueuePhoto } from './types';

let opening: Promise<QueueStore> | undefined;
export function getQueue(): Promise<QueueStore> {
  if (!opening) {
    opening = openDatabaseAsync('momentlens-upload-queue.db')
      .then(async (db) => {
        const store = new QueueStore(db, queueFiles, randomUUID);
        await store.initialize();
        // Reads start at once. An enqueue made during the sweep waits behind it.
        void store.sweep();
        return store;
      })
      .catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
  }
  return opening;
}
export async function initializeQueue(): Promise<void> {
  await getQueue();
}
export async function enqueue(
  userId: string,
  eventId: string,
  subEventId: string,
  photo: QueuePhoto,
) {
  return (await getQueue()).enqueue(userId, eventId, subEventId, photo);
}
export async function remove(userId: string, id: string) {
  return (await getQueue()).remove(userId, id);
}
export async function listForEvent(userId: string, eventId: string) {
  return (await getQueue()).listForEvent(userId, eventId);
}
export async function update(userId: string, id: string, patch: QueuePatch) {
  return (await getQueue()).update(userId, id, patch);
}
