import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AuthRetryableFetchError, type AuthChangeEvent, type Session } from '@supabase/supabase-js';

import type * as LogoutModule from '@/features/auth/logout';
import type * as SessionModule from '@/features/auth/session';
import type * as StoreModule from '@/stores/auth';

type Listener = (event: AuthChangeEvent, session: Session | null) => Promise<void>;

// What lib/supabase would hold. `storedUserId` is the user of the session in MMKV, or null when
// storage holds none, and `userIdAtLaunch` is what storage held before auth-js started.
const mockState = {
  listener: null as Listener | null,
  userIdAtLaunch: null as string | null,
  storedUserId: null as string | null,
  // auth-js 2.116.0's signOut returns an error and leaves the session in storage when it cannot
  // load the session first, which is what happens offline once the access token has expired.
  signOutLeavesSession: false,
};

const mockSupabase = {
  auth: {
    onAuthStateChange: jest.fn((listener: Listener) => {
      mockState.listener = listener;
      return { data: { subscription: { unsubscribe: jest.fn() } } };
    }),
    initialize: jest.fn(() => Promise.resolve({ error: null })),
    // Removing the session and announcing SIGNED_OUT to every subscriber, then resolving, is what
    // auth-js does. It awaits the subscriber, so a subscriber that throws makes signOut reject.
    signOut: jest.fn(async (_options?: { scope?: string }) => {
      if (mockState.signOutLeavesSession) {
        return { error: new AuthRetryableFetchError('Network request failed', 0) };
      }
      mockState.storedUserId = null;
      await mockState.listener?.('SIGNED_OUT', null);
      return { error: null };
    }),
  },
};

jest.mock('@/lib/supabase', () => ({
  supabase: mockSupabase,
  get userIdAtLaunch() {
    return mockState.userIdAtLaunch;
  },
  storedSessionUserId: () => mockState.storedUserId,
  removeStoredSession: () => {
    mockState.storedUserId = null;
  },
}));

const mockQueryClient = {
  cancelQueries: jest.fn(() => Promise.resolve()),
  clear: jest.fn(),
};
jest.mock('@/lib/query-client', () => ({ queryClient: mockQueryClient }));

const mockImage = {
  clearMemoryCache: jest.fn(() => Promise.resolve(true)),
  clearDiskCache: jest.fn(() => Promise.resolve(true)),
};
jest.mock('expo-image', () => ({ Image: mockImage }));

function sessionFor(userId: string): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: userId },
  } as unknown as Session;
}

interface Loaded {
  startSessionSync: typeof SessionModule.startSessionSync;
  logout: typeof LogoutModule.logout;
  useAuthStore: typeof StoreModule.useAuthStore;
  acknowledgeSessionEnded: typeof StoreModule.acknowledgeSessionEnded;
}

// session.ts starts once per JavaScript load, so each test loads its own copy of it, the store and
// logout.ts together, from one registry, so that all three share one store.
function start(launch: { userIdAtLaunch: string | null; storedUserId?: string | null }): Loaded {
  mockState.userIdAtLaunch = launch.userIdAtLaunch;
  mockState.storedUserId =
    launch.storedUserId === undefined ? launch.userIdAtLaunch : launch.storedUserId;
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    const session = jest.requireActual<typeof SessionModule>('@/features/auth/session');
    const logout = jest.requireActual<typeof LogoutModule>('@/features/auth/logout');
    const store = jest.requireActual<typeof StoreModule>('@/stores/auth');
    loaded = {
      startSessionSync: session.startSessionSync,
      logout: logout.logout,
      useAuthStore: store.useAuthStore,
      acknowledgeSessionEnded: store.acknowledgeSessionEnded,
    };
  });
  if (loaded === undefined) {
    throw new Error('the session modules did not load');
  }
  loaded.startSessionSync();
  return loaded;
}

// auth-js saves a session to storage before it announces it, so storage follows every event that
// carries one.
async function emit(event: AuthChangeEvent, session: Session | null) {
  if (mockState.listener === null) {
    throw new Error('session.ts never subscribed to onAuthStateChange');
  }
  if (session !== null) {
    mockState.storedUserId = session.user.id;
  }
  await mockState.listener(event, session);
}

// Lets the reconcile step after supabase.auth.initialize() run.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function expectCachesCleared() {
  expect(mockQueryClient.clear).toHaveBeenCalled();
  expect(mockImage.clearMemoryCache).toHaveBeenCalled();
  expect(mockImage.clearDiskCache).toHaveBeenCalled();
}

afterEach(() => {
  jest.clearAllMocks();
  mockState.listener = null;
  mockState.signOutLeavesSession = false;
  mockQueryClient.cancelQueries.mockImplementation(() => Promise.resolve());
});

describe('a session that cannot be refreshed', () => {
  it('stays signed in, with no Forced Logout, when the refresh fails offline', async () => {
    // Offline an hour after the last use, auth-js keeps the session in storage but tells its first
    // subscriber there is none.
    const app = start({ userIdAtLaunch: 'user-a' });
    await emit('INITIAL_SESSION', null);
    await settle();

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedIn', userId: 'user-a' });
    expect(mockSupabase.auth.signOut).not.toHaveBeenCalled();
  });

  it('shows Forced Logout when Supabase rejects the refresh token', async () => {
    const app = start({ userIdAtLaunch: 'user-a' });
    await settle();

    // auth-js removes the session and says SIGNED_OUT, and nobody chose to log out.
    mockState.storedUserId = null;
    await emit('SIGNED_OUT', null);

    expect(app.useAuthStore.getState()).toEqual({ status: 'sessionEnded', userId: null });
    expectCachesCleared();
  });

  it('shows Forced Logout at launch when startup removed the stored session', async () => {
    // The refresh token was revoked while the app was closed. Startup's refresh is rejected and
    // auth-js removes the session, whether or not its SIGNED_OUT reaches this subscriber.
    const app = start({ userIdAtLaunch: 'user-a', storedUserId: null });
    await settle();

    expect(app.useAuthStore.getState()).toEqual({ status: 'sessionEnded', userId: null });
    expectCachesCleared();
  });

  it('keeps Forced Logout when a second SIGNED_OUT follows the first', async () => {
    // The API client signs out after a rejected refresh, and auth-js may already have removed the
    // session and said SIGNED_OUT once.
    const app = start({ userIdAtLaunch: 'user-a' });
    mockState.storedUserId = null;
    await emit('SIGNED_OUT', null);
    await emit('SIGNED_OUT', null);

    expect(app.useAuthStore.getState().status).toBe('sessionEnded');
  });

  it('goes to Login once Forced Logout is acknowledged', async () => {
    const app = start({ userIdAtLaunch: 'user-a' });
    mockState.storedUserId = null;
    await emit('SIGNED_OUT', null);

    app.acknowledgeSessionEnded();

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedOut', userId: null });
  });
});

describe('logout', () => {
  it('goes to Login, not Forced Logout, and signs out this device only', async () => {
    const app = start({ userIdAtLaunch: 'user-a' });
    await settle();

    await app.logout();

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedOut', userId: null });
    expect(mockSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('clears the query cache and both expo-image caches before it resolves', async () => {
    const app = start({ userIdAtLaunch: 'user-a' });
    await settle();
    jest.clearAllMocks();

    await app.logout();

    expectCachesCleared();
  });

  it('logs out offline even when signOut leaves the session in storage', async () => {
    const app = start({ userIdAtLaunch: 'user-a' });
    await settle();
    jest.clearAllMocks();
    mockState.signOutLeavesSession = true;

    await app.logout();

    expect(mockState.storedUserId).toBeNull();
    expect(app.useAuthStore.getState()).toEqual({ status: 'signedOut', userId: null });
    expectCachesCleared();
  });
});

describe('who is signed in', () => {
  it('starts signed out and clears the image caches when storage holds no session', async () => {
    // A logout the app died in the middle of can leave the last account's images on disk.
    const app = start({ userIdAtLaunch: null });
    await settle();

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedOut', userId: null });
    expect(mockImage.clearDiskCache).toHaveBeenCalled();
  });

  it('signs in on SIGNED_IN, which is how login and signup reach Home', async () => {
    const app = start({ userIdAtLaunch: null });
    await emit('SIGNED_IN', sessionFor('user-a'));

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedIn', userId: 'user-a' });
  });

  it('clears the caches when another account signs in with no logout between', async () => {
    // A reset link for account B, opened while A is signed in, swaps the session in place.
    const app = start({ userIdAtLaunch: 'user-a' });
    await settle();
    jest.clearAllMocks();

    await emit('PASSWORD_RECOVERY', sessionFor('user-b'));

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedIn', userId: 'user-b' });
    expectCachesCleared();
  });

  it('keeps the caches when the same account refreshes its token', async () => {
    start({ userIdAtLaunch: 'user-a' });
    await settle();
    jest.clearAllMocks();

    await emit('TOKEN_REFRESHED', sessionFor('user-a'));

    expect(mockQueryClient.clear).not.toHaveBeenCalled();
    expect(mockImage.clearDiskCache).not.toHaveBeenCalled();
  });

  it('stays on Login when SIGNED_OUT arrives with nobody signed in', async () => {
    const app = start({ userIdAtLaunch: null });
    await emit('SIGNED_OUT', null);

    expect(app.useAuthStore.getState()).toEqual({ status: 'signedOut', userId: null });
  });

  it('never throws out of the auth callback, which would make signOut reject', async () => {
    const app = start({ userIdAtLaunch: 'user-a' });
    await settle();
    mockQueryClient.cancelQueries.mockImplementation(() => Promise.reject(new Error('boom')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(emit('SIGNED_OUT', null)).resolves.toBeUndefined();

    expect(app.useAuthStore.getState().status).toBe('sessionEnded');
    warn.mockRestore();
  });
});
