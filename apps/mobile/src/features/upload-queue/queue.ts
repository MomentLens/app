import { onlineManager, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { openDatabaseAsync } from 'expo-sqlite';
import { AppState } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { eventQueryKey, recheckEvent } from '@/features/event-shell/use-event';
import { completeUpload, preflightUpload } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';
import { CaptureStore } from '@/features/capture/capture-store';
import { captureFiles } from '@/features/capture/capture-files';

import { queueFiles } from './files';
import { prepareUpload } from './prepare';
import { gateFor, UploadRunner, type NetworkGate, type PutResult } from './runner';
import { stallGuard } from './stall';
import { QueueStore } from './store';
import type { QueuePatch, QueuePhoto, WaitingState } from './types';

// Opens without waiting for backup exclusion (D-153). A failed exclusion stops each capture before
// its shot, in capture.ts, so the queue stays readable and Public uploads keep going.
let opening: Promise<QueueStore> | undefined;
export function getQueue(): Promise<QueueStore> {
  if (!opening) {
    opening = openDatabaseAsync('momentlens-upload-queue.db')
      .then(async (db) => {
        const store = new QueueStore(db, queueFiles, randomUUID);
        await store.initialize();
        await new CaptureStore(store, captureFiles).recover();
        // Reads start at once. An enqueue made during the sweep waits behind it, and so does the
        // runner's first write, so Stage 1 never writes an upload.jpg the sweep could take.
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
  const item = await (await getQueue()).enqueue(userId, eventId, subEventId, photo);
  void runner.run();
  return item;
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

// "Upload over Mobile Data", which S-29's toggle writes. Default on (D-146).
const preferences = createMMKV({ id: 'device-preferences' });
const MOBILE_DATA_KEY = 'uploadOverMobileData';

async function gate(): Promise<NetworkGate> {
  const online = onlineManager.isOnline();
  const mobileData = preferences.getBoolean(MOBILE_DATA_KEY) !== false;
  if (!online || mobileData) return gateFor(online, mobileData, undefined);
  try {
    const { type } = await getNetworkStateAsync();
    return gateFor(online, mobileData, type);
  } catch {
    // Unknown, with Mobile Data off: wait. The next network change wakes the runner.
    return 'cellular';
  }
}

// D-146's routine call. A PUT with no progress for 2 minutes is cancelled. One that keeps sending
// runs until the presigned URL expires, 15 minutes after pre-flight.
const PUT_STALL_MS = 2 * 60_000;

// A queue file goes straight from the phone to R2 on its presigned URL, never through the API
// (root invariant 5), with only the content type the API signed and never the API's token.
async function put(
  path: string,
  url: string,
  contentType: string,
  signal: AbortSignal,
): Promise<PutResult> {
  const file = new File(queueFiles.uri(path));
  if (!file.exists) return 'missing';
  if (signal.aborted) return 'failed';
  const guard = stallGuard(signal, PUT_STALL_MS);
  try {
    const result = await file.upload(url, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': contentType },
      onProgress: guard.progress,
      signal: guard.signal,
    });
    return result.status >= 200 && result.status < 300 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  } finally {
    guard.dispose();
  }
}

// The app's one runner (D-146).
const runner = new UploadRunner({
  store: getQueue,
  userId: () => useAuthStore.getState().userId,
  prepare: (item) => {
    if (item.photoPath === null) throw new Error('The queued photo has no file.');
    return prepareUpload(item.photoPath, queueFiles);
  },
  discard: (path) => queueFiles.delete(path),
  preflight: preflightUpload,
  complete: completeUpload,
  put,
  gate,
  lostAccess: recheckEvent,
  now: Date.now,
  schedule: (wake, delayMs) => {
    const timer = setTimeout(wake, delayMs);
    return () => clearTimeout(timer);
  },
  warn: (message, error) => console.warn(message, error),
});

// S-14's background task calls this, the same runner, and it resolves once the runner is idle.
export function runUploads(): Promise<void> {
  return runner.retryNow();
}

// Moves one event's waiting photos back to queued and uploads them. S-31 calls it once the event
// response shows the album open, and S-15 once the local GPS or QR check passes or the event
// response shows the person verified (D-146).
export async function release(
  userId: string,
  eventId: string,
  state: WaitingState,
): Promise<number> {
  const released = await (await getQueue()).release(userId, eventId, state);
  if (released) void runner.retryNow();
  return released;
}

// A fresh 200 from GET /events/{eventId} releases the account's photos stopped there by
// not_member or not_found (D-146). Only a fetch counts. A setQueryData write is marked manual, and
// a copy restored from disk or seeded from the Events list never arrives as a success.
function releaseOnFreshEvent(event: QueryCacheNotifyEvent): void {
  if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
  const { queryKey } = event.query;
  const eventId = queryKey[1];
  if (typeof eventId !== 'string') return;
  const expected = eventQueryKey(eventId);
  if (queryKey.length !== expected.length || expected.some((part, i) => queryKey[i] !== part)) {
    return;
  }
  const userId = useAuthStore.getState().userId;
  if (userId === null) return;
  // run(), never retryNow(), which would clear the backoff the release just set.
  void getQueue()
    .then((store) => store.releaseLostAccess(userId, eventId, Date.now()))
    .then((released) => {
      if (released) void runner.run();
    })
    .catch(() => undefined);
}

// Fast Refresh runs this module again with a new runner, while the old runner and its listeners
// live on. The teardown sits on globalThis, the one place both copies of the module can reach, so
// the new start stops the old runner first and one runner moves the queue (D-146).
const TEARDOWN = '__momentlensStopUploads';
type Global = typeof globalThis & { [TEARDOWN]?: () => void };

let started = false;
// Wires the runner to everything that wakes it. The root layout calls this once, after the
// session sync has put the launch's account in the store.
export function startUploads(): void {
  if (started) return;
  started = true;
  (globalThis as Global)[TEARDOWN]?.();
  let owner = useAuthStore.getState().userId;
  const unsubscribers: (() => void)[] = [
    useAuthStore.subscribe((state) => {
      if (state.userId === owner) return;
      owner = state.userId;
      void runner.accountChanged();
    }),
  ];
  // Foreground and reconnect retry at once (D-146).
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void runner.retryNow();
  });
  unsubscribers.push(() => appState.remove());
  unsubscribers.push(
    onlineManager.subscribe((online) => {
      if (online) void runner.retryNow();
    }),
  );
  // Joining Wi-Fi from cellular, which onlineManager does not report, lets a photo waiting on
  // Mobile Data go. So does S-29's toggle turning it on.
  const network = addNetworkStateListener(() => {
    void runner.run();
  });
  unsubscribers.push(() => network.remove());
  const mobileData = preferences.addOnValueChangedListener((key) => {
    if (key === MOBILE_DATA_KEY) void runner.run();
  });
  unsubscribers.push(() => mobileData.remove());
  // A photo that drew a 401 waits for the session (arch §4). A sign-in changes the account above.
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'TOKEN_REFRESHED') void runner.retryNow();
  });
  unsubscribers.push(() => subscription.unsubscribe());
  unsubscribers.push(queryClient.getQueryCache().subscribe(releaseOnFreshEvent));
  (globalThis as Global)[TEARDOWN] = () => {
    runner.shutdown();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
  void runner.retryNow();
}
