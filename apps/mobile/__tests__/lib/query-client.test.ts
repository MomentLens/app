import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { GetEventResponse } from '@momentlens/shared-types';
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from '@tanstack/react-query-persist-client';

import type * as LogoutModule from '@/features/auth/logout';
import type * as QueryClientModule from '@/lib/query-client';
import type * as StoreModule from '@/stores/auth';

// One Map for every load, so a second load of the modules reads what the first wrote, as the next
// launch reads MMKV. MMKV's own Jest mock starts empty on every load.
const mockStorage = new Map<string, string>();
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => {
      mockStorage.set(key, value);
    },
    remove: (key: string) => mockStorage.delete(key),
  }),
}));

// clearAccountCaches clears expo-image too. logout.ts imports these, and lib/supabase would throw
// for want of its environment variables.
jest.mock('expo-image', () => ({
  Image: {
    clearMemoryCache: jest.fn(() => Promise.resolve(true)),
    clearDiskCache: jest.fn(() => Promise.resolve(true)),
  },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: {} },
  storedSessionUserId: () => null,
  removeStoredSession: () => undefined,
}));
jest.mock('@/features/join/pending-invite', () => ({ clearPendingInvite: () => undefined }));

// The listener query-client.ts hands expo-network, so a test can say the network came or went.
let mockNetworkListener:
  ((state: { isConnected?: boolean; isInternetReachable?: boolean }) => void) | null = null;
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: typeof mockNetworkListener) => {
    mockNetworkListener = listener;
    return { remove: () => undefined };
  },
}));

const EVENT_ID = '6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f';
const EVENT_KEY = ['event', EVENT_ID];
const EVENT: GetEventResponse = {
  event: {
    id: EVENT_ID,
    name: 'Him & Her',
    type: 'wedding',
    role: 'guest',
    cover: null,
    startsAt: '2026-10-30T10:00:00.000Z',
    endsAt: '2026-10-30T22:00:00.000Z',
    archivedAt: null,
  },
};

interface App {
  lib: typeof QueryClientModule;
  clearAccountCaches: typeof LogoutModule.clearAccountCaches;
  useAuthStore: typeof StoreModule.useAuthStore;
}

const launched: App[] = [];

// One launch of the app: fresh modules over the same storage, signed in as `userId`, as
// startSessionSync leaves the store before the root layout restores.
function launch(userId: string | null): App {
  let app: App | undefined;
  jest.isolateModules(() => {
    app = {
      lib: jest.requireActual<typeof QueryClientModule>('@/lib/query-client'),
      clearAccountCaches:
        jest.requireActual<typeof LogoutModule>('@/features/auth/logout').clearAccountCaches,
      useAuthStore: jest.requireActual<typeof StoreModule>('@/stores/auth').useAuthStore,
    };
  });
  if (app === undefined) {
    throw new Error('the modules did not load');
  }
  app.useAuthStore.setState({ status: userId === null ? 'signedOut' : 'signedIn', userId });
  launched.push(app);
  return app;
}

function options(app: App) {
  return { queryClient: app.lib.queryClient, ...app.lib.persistOptions };
}

async function fetchEvent(app: App, persisted = true) {
  await app.lib.queryClient.fetchQuery({
    queryKey: EVENT_KEY,
    queryFn: () => Promise.resolve(EVENT),
    ...(persisted ? app.lib.PERSISTED_QUERY : {}),
  });
}

// A refetch that fails, as useEvent's would, keeping the data from before. It passes the same
// options useEvent does, since a query takes the options of its latest fetch.
async function refetchFails(app: App, error: unknown) {
  await app.lib.queryClient
    .fetchQuery({
      queryKey: EVENT_KEY,
      queryFn: () => Promise.reject(error),
      retry: false,
      staleTime: 0,
      ...app.lib.PERSISTED_QUERY,
    })
    .catch(() => undefined);
  expect(app.lib.queryClient.getQueryState(EVENT_KEY)?.status).toBe('error');
  expect(app.lib.queryClient.getQueryData(EVENT_KEY)).toEqual(EVENT);
}

// What the next launch finds, restored the way PersistQueryClientProvider restores it.
async function restoredEvent(userId: string | null): Promise<unknown> {
  const next = launch(userId);
  await persistQueryClientRestore(options(next)).catch(() => undefined);
  return next.lib.queryClient.getQueryData(EVENT_KEY);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  // A persisted query holds a 14-day garbage-collection timer, which clear() cancels.
  for (const app of launched.splice(0)) {
    app.lib.queryClient.clear();
  }
  mockStorage.clear();
});

describe('the persisted query cache', () => {
  it('gives the same account its event back on the next launch, with no network', async () => {
    const app = launch('user-a');
    await fetchEvent(app);
    await persistQueryClientSave(options(app));

    expect(await restoredEvent('user-a')).toEqual(EVENT);
  });

  it('leaves the next account no persisted event after a logout', async () => {
    const app = launch('user-a');
    const unsubscribe = persistQueryClientSubscribe(options(app));
    await fetchEvent(app);
    await wait(10);

    // logout() and an ended session both move the store first, then clear.
    app.useAuthStore.setState({ status: 'signedOut', userId: null });
    await app.clearAccountCaches();
    expect(mockStorage.size).toBe(0);

    // The throttled save clear() set off lands a second later, with nothing in it.
    await wait(1_100);
    unsubscribe();

    expect(await restoredEvent('user-b')).toBeUndefined();
    expect(await restoredEvent('user-a')).toBeUndefined();
  });

  it('removes the copy a save already under way writes while the cache clears', async () => {
    const app = launch('user-a');
    const unsubscribe = persistQueryClientSubscribe(options(app));
    // The list goes in first, so clear() removes it first and tells the persister while the event
    // is still in the cache. With no save in the last second, that save starts at once.
    await app.lib.queryClient.fetchQuery({
      queryKey: ['events'],
      queryFn: () => Promise.resolve({ events: [EVENT.event], joinRequests: [] }),
      ...app.lib.PERSISTED_QUERY,
    });
    await fetchEvent(app);
    // The throttle writes at most once a second, and the write it deferred during the fetches
    // lands a second in, so two seconds leave it idle.
    await wait(2_100);

    app.useAuthStore.setState({ status: 'signedOut', userId: null });
    await app.clearAccountCaches();
    expect(mockStorage.size).toBe(0);

    await wait(1_100);
    unsubscribe();
    expect(await restoredEvent('user-a')).toBeUndefined();
  });

  it('leaves the next account no persisted event after a session ends', async () => {
    const app = launch('user-a');
    const unsubscribe = persistQueryClientSubscribe(options(app));
    await fetchEvent(app);
    await wait(10);

    app.useAuthStore.setState({ status: 'sessionEnded', userId: null });
    await app.clearAccountCaches();
    await wait(1_100);
    unsubscribe();

    expect(await restoredEvent('user-b')).toBeUndefined();
  });

  it("never restores one account's event for another, even when nothing cleared it", async () => {
    const app = launch('user-a');
    await fetchEvent(app);
    await persistQueryClientSave(options(app));

    expect(await restoredEvent('user-b')).toBeUndefined();
    // The restore removed it, so user-a does not get it back later either.
    expect(mockStorage.size).toBe(0);
  });

  it('restores nothing when nobody is signed in at launch', async () => {
    const app = launch('user-a');
    await fetchEvent(app);
    await persistQueryClientSave(options(app));

    expect(await restoredEvent(null)).toBeUndefined();
  });

  it('drops an event the API now refuses, so a removed member keeps no copy', async () => {
    const app = launch('user-a');
    await fetchEvent(app);
    await refetchFails(app, { status: 403, code: 'not_member' });
    await persistQueryClientSave(options(app));

    expect(await restoredEvent('user-a')).toBeUndefined();
  });

  it('keeps an event whose last refetch failed offline, the copy a cold start needs', async () => {
    const app = launch('user-a');
    await fetchEvent(app);
    await refetchFails(app, new Error('Could not reach the API.'));
    await persistQueryClientSave(options(app));

    expect(await restoredEvent('user-a')).toEqual(EVENT);
  });

  it('saves only the queries marked to persist', async () => {
    const app = launch('user-a');
    await fetchEvent(app, false);
    await persistQueryClientSave(options(app));

    expect(await restoredEvent('user-a')).toBeUndefined();
  });
});

describe('reconnect', () => {
  it('tells TanStack Query when the network goes and comes back, so stale queries refetch (D-121)', () => {
    jest.isolateModules(() => {
      const lib = jest.requireActual<typeof QueryClientModule>('@/lib/query-client');
      launched.push({ lib } as App);
      const { onlineManager } =
        jest.requireActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');

      mockNetworkListener?.({ isConnected: false, isInternetReachable: false });
      expect(onlineManager.isOnline()).toBe(false);
      mockNetworkListener?.({ isConnected: true, isInternetReachable: true });
      expect(onlineManager.isOnline()).toBe(true);
      mockNetworkListener?.({ isConnected: true, isInternetReachable: false });
      expect(onlineManager.isOnline()).toBe(false);
      // Android can report reachability as unknown for a moment; only a definite no is offline.
      mockNetworkListener?.({ isConnected: true });
      expect(onlineManager.isOnline()).toBe(true);
    });
  });

  it('never pauses a query or a write for want of a network, so an Admin write is refused, not queued', () => {
    const app = launch('user-a');
    const defaults = app.lib.queryClient.getDefaultOptions();
    expect(defaults.queries?.networkMode).toBe('always');
    expect(defaults.mutations?.networkMode).toBe('always');
  });
});
