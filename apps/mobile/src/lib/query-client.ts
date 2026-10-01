import { MAX_EVENT_SPAN_MS } from '@momentlens/shared-types';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { focusManager, onlineManager, QueryClient, type Query } from '@tanstack/react-query';
import type {
  PersistedClient,
  PersistQueryClientOptions,
} from '@tanstack/react-query-persist-client';
import { addNetworkStateListener, type NetworkState } from 'expo-network';
import { AppState, Platform } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { useAuthStore } from '@/stores/auth';

// The app's one TanStack Query client. It lives in a module rather than in the root layout's state
// so that ending a session can clear it from outside React (features/auth/logout.ts). Editing
// another file keeps the cache across Fast Refresh, because only the edited module re-runs.
//
// Nothing waits for a network. A query fails offline, so a cold start shows its persisted copy or
// its error state rather than a spinner, and an Admin's write is refused rather than queued
// (D-121). Knowing the network state only makes stale queries refetch on reconnect, below.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } },
});

// How long a persisted query lasts with the app closed: an event's longest span, so a guest who
// last opened the app on the first day still gets in on the last one with no signal.
export const PERSISTED_MAX_AGE_MS = MAX_EVENT_SPAN_MS;

// Spread into a query's options to keep its answer across a restart (D-118). Only these queries
// are written to disk, and the gcTime keeps one in memory as long as the disk copy lives, since
// TanStack Query drops a query from the saved cache once it is garbage collected.
export const PERSISTED_QUERY = {
  meta: { persist: true },
  gcTime: PERSISTED_MAX_AGE_MS,
} as const;

// Bump when the shape of a persisted response changes, so a phone never restores one the new code
// cannot read. Nothing parses a restored answer again.
const PERSISTED_SHAPE = '1';

// An answer the API refused, such as the 403 a removed member gets. Read off the error's status
// rather than with instanceof ApiError, which would pull the API client and Supabase into this
// module.
function refused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const { status } = error;
  return typeof status === 'number' && status >= 400 && status < 500;
}

// A marked query with data goes to disk, including one whose last refetch failed offline: that is
// the copy a cold start with no signal needs. One the API has refused is left off, so a removed
// member's event leaves the phone at the next save.
function shouldPersist(query: Query): boolean {
  return (
    query.meta?.persist === true && query.state.data !== undefined && !refused(query.state.error)
  );
}

// The account each saved cache belongs to goes with it, and a launch restores only its own
// account's. Logging out removes the cache anyway (features/auth/logout.ts); this covers a phone
// that died before that finished, since the team hands phones around (spec §4.1).
interface SavedCache {
  userId: string | null;
  client: PersistedClient;
}

// A timestamp of 0 makes TanStack Query remove the saved cache rather than restore it.
const DISCARD: PersistedClient = {
  timestamp: 0,
  buster: '',
  clientState: { queries: [], mutations: [] },
};

const storage = createMMKV({ id: 'query-cache' });

export const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: (key: string) => storage.getString(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => {
      storage.remove(key);
    },
  },
  key: 'momentlens-queries',
  serialize: (client) => {
    const saved: SavedCache = { userId: useAuthStore.getState().userId, client };
    return JSON.stringify(saved);
  },
  // The root layout restores once, after startSessionSync has put the launch's account in the
  // store.
  deserialize: (raw) => {
    const saved = JSON.parse(raw) as SavedCache;
    const owner = useAuthStore.getState().userId;
    return saved.userId !== null && saved.userId === owner ? saved.client : DISCARD;
  },
});

// What the root layout's PersistQueryClientProvider takes. A restored query is held as long as
// a live one, because hydrate builds it with these defaults rather than the query's own options.
export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister: queryPersister,
  maxAge: PERSISTED_MAX_AGE_MS,
  buster: PERSISTED_SHAPE,
  dehydrateOptions: {
    shouldDehydrateQuery: shouldPersist,
    shouldDehydrateMutation: () => false,
  },
  hydrateOptions: { defaultOptions: { queries: { gcTime: PERSISTED_MAX_AGE_MS } } },
};

// Empties the cache and its copy on disk, for logout() and every other end of an account.
export async function clearQueries(): Promise<void> {
  // A query still in flight would otherwise land in the cache after it was cleared.
  await queryClient.cancelQueries();
  queryClient.clear();
  // clear() tells the persister about each query as it goes, so a write may already be under way
  // with a snapshot that still holds some of them. MMKV is synchronous, so that write lands within
  // the current microtasks, and the disk copy is removed after it. The throttled write that follows
  // a second later saves the empty cache.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await queryPersister.removeClient();
}

// React Native has no window focus, so TanStack Query never refetches on return to the app by
// itself. Telling it the app is focused while it is active refetches stale queries whenever the
// app comes back to the foreground, which is when a presigned URL may have expired (arch §3).
focusManager.setEventListener((setFocused) => {
  if (Platform.OS === 'web') {
    return undefined;
  }
  const subscription = AppState.addEventListener('change', (state) => {
    setFocused(state === 'active');
  });
  return () => subscription.remove();
});

// Online unless expo-network says otherwise. Android can report reachability as unknown for a
// moment after a change, and only a definite no counts as offline.
function isOnline(state: NetworkState): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

// React Native has no browser online event, so TanStack Query would believe the phone is always
// online and never refetch on reconnect. expo-network tells it instead, and the event, the Events
// list and the schedule refetch when the network comes back (D-118, D-121).
onlineManager.setEventListener((setOnline) => {
  if (Platform.OS === 'web') {
    return undefined;
  }
  const subscription = addNetworkStateListener((state) => {
    setOnline(isOnline(state));
  });
  return () => subscription.remove();
});
