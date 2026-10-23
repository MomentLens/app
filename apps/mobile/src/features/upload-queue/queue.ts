import { onlineManager, type QueryCacheNotifyEvent } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { getPermissionsAsync, requestPermissionsAsync } from 'expo-notifications';
import { openDatabaseAsync } from 'expo-sqlite';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { createMMKV } from 'react-native-mmkv';
import type { GetEventResponse, ListSubEventsResponse } from '@momentlens/shared-types';

import { eventQueryKey, recheckEvent } from '@/features/event-shell/use-event';
import { EVENTS_QUERY_KEY } from '@/features/events/use-events';
import { completeUpload, preflightUpload } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';
import { CaptureStore } from '@/features/capture/capture-store';
import { captureFiles } from '@/features/capture/capture-files';
import { subEventsQueryKey } from '@/features/schedule/use-sub-events';
import { VerificationGate } from '@/features/verification/gate';
import { GpsReadings } from '@/features/verification/readings';
import { QrScans } from '@/features/verification/qr-scans';

import {
  addEndedListener,
  startProtection,
  stopProtection,
} from '../../../modules/background-upload';

import { askNotificationsOnce, BackgroundCoordinator } from './background';
import { registerBackgroundHold } from './background-task';
import { queueFiles } from './files';
import { prepareUpload } from './prepare';
import { gateFor, UploadRunner, type NetworkGate, type PutResult } from './runner';
import { stallGuard } from './stall';
import { QueueStore } from './store';
import type { QueuePatch, QueuePhoto, WaitingState, VerificationScope } from './types';

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
export async function getGpsReadings(): Promise<GpsReadings> {
  return new GpsReadings(await getQueue());
}
export async function getQrScans(): Promise<QrScans> {
  return new QrScans(await getQueue());
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

const verification = new VerificationGate({
  readings: getGpsReadings,
  scans: getQrScans,
  event: (eventId) => queryClient.getQueryData<GetEventResponse>(eventQueryKey(eventId)),
  eventRevision: (eventId) => queryClient.getQueryState(eventQueryKey(eventId))?.dataUpdateCount,
  schedule: (eventId) =>
    queryClient.getQueryData<ListSubEventsResponse>(subEventsQueryKey(eventId)),
  refetch: (eventId) => {
    void queryClient.invalidateQueries({ queryKey: eventQueryKey(eventId), exact: true });
    void queryClient.invalidateQueries({ queryKey: subEventsQueryKey(eventId), exact: true });
  },
});

// The album state in each event answer the API sent, per account, and when it arrived. Only
// releaseOnOpenAlbum writes it, from fetched answers, so a copy restored from disk, seeded from the
// Events list or written by the app never lands here (D-161).
const albumAnswers = new Map<string, { open: boolean; at: number }>();
const albumKey = (userId: string, eventId: string) => `${userId}\0${eventId.toLowerCase()}`;

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
  verification,
  lostAccess: recheckEvent,
  albumAnswer: (userId, eventId) => albumAnswers.get(albumKey(userId, eventId)),
  now: Date.now,
  schedule: (wake, delayMs) => {
    const timer = setTimeout(wake, delayMs);
    return () => clearTimeout(timer);
  },
  // Read lazily: the coordinator below wraps this runner.
  activity: (userId, activity) => coordinator.activity(userId, activity),
  warn: (message, error) => console.warn(message, error),
});

// Android's notification prompt for the upload service, asked once on this device (D-158).
const NOTIFICATIONS_ASKED_KEY = 'uploadNotificationsAsked';

// Keeps the runner going in the background while the system allows it, and suspends it once
// protection ends (D-158). It starts suspended when the app loads in the background.
const coordinator = new BackgroundCoordinator(
  {
    native: { start: startProtection, stop: stopProtection },
    runner,
    userId: () => useAuthStore.getState().userId,
    makeId: randomUUID,
    askNotifications: () =>
      askNotificationsOnce({
        android: Platform.OS === 'android',
        asked: () => preferences.getBoolean(NOTIFICATIONS_ASKED_KEY) === true,
        markAsked: () => preferences.set(NOTIFICATIONS_ASKED_KEY, true),
        current: getPermissionsAsync,
        request: requestPermissionsAsync,
      }),
    warn: (message, error) => console.warn(message, error),
  },
  AppState.currentState !== 'background',
);

// My Media's keep-open notice: the account whose background start the system refused.
export function useRefusedBackgroundAccount(): string | null {
  return useSyncExternalStore(coordinator.subscribe, coordinator.refusedFor);
}

// A capture handed to the queue in the foreground uploads now, past any backoff. It resolves once
// the runner is idle. A suspended runner waits for the foreground.
export function runUploads(): Promise<void> {
  return runner.retryNow();
}

// Moves one event's waiting photos back to queued and uploads them. S-31 calls it once a fetched
// event answer shows the album open (releaseOnOpenAlbum), and S-15 once the local GPS or QR check passes or the event
// response shows the person verified (D-146).
export async function release(
  userId: string,
  eventId: string,
  state: WaitingState,
  subEventIds?: VerificationScope,
): Promise<number> {
  const released = await (await getQueue()).release(userId, eventId, state, subEventIds);
  if (released) void (state === 'waiting_verification' ? runner.run() : runner.retryNow());
  return released;
}

async function releaseCovered(userId: string, eventId: string): Promise<void> {
  const covered = await verification.coverage(userId, eventId);
  if (useAuthStore.getState().userId !== userId) return;
  await release(userId, eventId, 'waiting_verification', covered);
}

async function releaseCachedVerifications(): Promise<void> {
  const userId = useAuthStore.getState().userId;
  if (userId === null) return;
  const heldEvents = [
    ...(await (await getGpsReadings()).eventIds(userId)),
    ...(await (await getQrScans()).eventIds(userId)),
  ];
  const cachedEvents = queryClient
    .getQueryCache()
    .findAll({ queryKey: ['event'] })
    .flatMap((query) => (typeof query.queryKey[1] === 'string' ? [query.queryKey[1]] : []));
  for (const eventId of new Set([...heldEvents, ...cachedEvents])) {
    if (useAuthStore.getState().userId !== userId) return;
    await releaseCovered(userId, eventId);
  }
}

// A fresh 200 from GET /events/{eventId} releases the account's photos stopped there by
// not_member or not_found (D-146). Only a fetch counts. A setQueryData write is marked manual, and
// a copy restored from disk or seeded from the Events list never arrives as a success.
function releaseOnFreshEvent(event: QueryCacheNotifyEvent): void {
  if (event.type !== 'updated' && event.type !== 'added') return;
  const { queryKey } = event.query;
  const eventId = queryKey[1];
  if (typeof eventId !== 'string') return;
  if (!sameKey(queryKey, eventQueryKey(eventId))) return;
  const userId = useAuthStore.getState().userId;
  if (userId === null) return;
  // Restoration and Events-list seeds can arrive after startUploads. A held fix and any cached
  // verification still recover the kill between storing and releasing (D-155).
  if (event.query.state.data !== undefined) {
    void releaseCovered(userId, eventId).catch(() => undefined);
  }
  if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
  // run(), never retryNow(), which would clear the backoff the release just set.
  void getQueue()
    .then((store) => store.releaseLostAccess(userId, eventId, Date.now()))
    .then((released) => {
      if (released) void runner.run();
    })
    .catch(() => undefined);
}

function sameKey(queryKey: readonly unknown[], expected: readonly unknown[]): boolean {
  return queryKey.length === expected.length && expected.every((part, i) => queryKey[i] === part);
}

// Each event's album state in a fetched answer from GET /events/{eventId} or GET /events. Read
// field by field, because the cache holds whatever the query returned.
function albumStates(queryKey: readonly unknown[], data: unknown): { id: string; open: boolean }[] {
  if (typeof data !== 'object' || data === null) return [];
  const eventId = queryKey[1];
  let events: unknown[] = [];
  if (typeof eventId === 'string' && sameKey(queryKey, eventQueryKey(eventId))) {
    events = [(data as { event?: unknown }).event];
  } else if (sameKey(queryKey, EVENTS_QUERY_KEY)) {
    const listed = (data as { events?: unknown }).events;
    events = Array.isArray(listed) ? listed : [];
  }
  return events.flatMap((event) => {
    if (typeof event !== 'object' || event === null) return [];
    const { id, albumOpen } = event as { id?: unknown; albumOpen?: unknown };
    return typeof id === 'string' && typeof albumOpen === 'boolean'
      ? [{ id, open: albumOpen }]
      : [];
  });
}

// A fetched answer from GET /events/{eventId} or GET /events that shows an album open releases
// that event's waiting_album photos (arch §4.3, D-161). Only a fetch counts: a setQueryData write
// is marked manual, and a copy restored from disk or seeded from the Events list never arrives as
// a success. Realtime on `event` only starts the fetch. Each answer is kept for the runner, which
// checks it again after a waiting write in case the album opened during that pre-flight.
function releaseOnOpenAlbum(event: QueryCacheNotifyEvent): void {
  if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
  const userId = useAuthStore.getState().userId;
  if (userId === null) return;
  const at = Date.now();
  for (const { id, open } of albumStates(event.query.queryKey, event.query.state.data)) {
    albumAnswers.set(albumKey(userId, id), { open, at });
    if (open) void release(userId, id, 'waiting_album').catch(() => undefined);
  }
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
      // Ends the old account's native task and cancels its attempt first (D-158).
      coordinator.accountChanged();
      void releaseCachedVerifications().catch(() => undefined);
    }),
  ];
  // Foreground resumes the runner and retries at once (D-146). Background entry keeps backoff and
  // suspends the runner unless native protection holds it (D-158). iOS's brief `inactive`, as
  // when Control Center opens, changes neither.
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') coordinator.foreground();
    else if (state === 'background') coordinator.background();
  });
  unsubscribers.push(() => appState.remove());
  unsubscribers.push(addEndedListener((taskId, reason) => coordinator.ended(taskId, reason)));
  unsubscribers.push(registerBackgroundHold(coordinator.hold));
  unsubscribers.push(
    onlineManager.subscribe((online) => {
      if (online) void runner.retryNow();
    }),
  );
  // Joining Wi-Fi from cellular, which onlineManager does not report, lets a photo waiting on
  // Mobile Data go. So does S-29's toggle turning it on.
  const network = addNetworkStateListener(() => {
    void runner.networkChanged();
  });
  unsubscribers.push(() => network.remove());
  const mobileData = preferences.addOnValueChangedListener((key) => {
    if (key === MOBILE_DATA_KEY) void runner.networkChanged();
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
  unsubscribers.push(queryClient.getQueryCache().subscribe(releaseOnOpenAlbum));
  (globalThis as Global)[TEARDOWN] = () => {
    coordinator.shutdown();
    runner.shutdown();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
  void releaseCachedVerifications().catch(() => undefined);
  // The launch's first pass, or a suspension if the app loaded in the background, with the
  // listeners above already attached.
  if (AppState.currentState === 'background') coordinator.background();
  else coordinator.foreground();
}
