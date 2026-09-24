import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type * as SupabaseModule from '@/lib/supabase';

type SupabaseLib = typeof SupabaseModule;
type ClientOptions = {
  auth: {
    storage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };
    storageKey: string;
    flowType: string;
    detectSessionInUrl: boolean;
    persistSession: boolean;
    autoRefreshToken: boolean;
  };
  global: { fetch: typeof fetch };
};

// MMKV's own Jest mock starts empty on every load, and these tests need a session to be in
// storage before lib/supabase reads it, so storage is one Map that outlives each load.
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

// The real client would start auth-js's refresh timer and keep Jest alive.
const mockCreateClient = jest.fn((_url: string, _key: string, _options: ClientOptions) => ({
  auth: { startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn() },
}));
jest.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }));

const mockGetRandomValues = jest.fn(<T>(array: T) => array);
jest.mock('expo-crypto', () => ({ getRandomValues: mockGetRandomValues }));

const STORAGE_KEY = 'momentlens-auth';
const originalFetch = globalThis.fetch;
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function load(): SupabaseLib {
  let lib: SupabaseLib | undefined;
  jest.isolateModules(() => {
    lib = jest.requireActual<SupabaseLib>('@/lib/supabase');
  });
  if (lib === undefined) {
    throw new Error('lib/supabase did not load');
  }
  return lib;
}

function optionsPassed(): ClientOptions {
  const options = mockCreateClient.mock.calls.at(-1)?.[2];
  if (options === undefined) {
    throw new Error('createClient was never called');
  }
  return options;
}

function storedSession(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: 1_900_000_000,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'user-a' },
    ...overrides,
  });
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
});

afterEach(() => {
  mockStorage.clear();
  jest.clearAllMocks();
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  if (cryptoDescriptor) {
    Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  }
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
});

describe('the client', () => {
  it('uses PKCE, keeps the session in MMKV under its own key and ignores URLs', () => {
    load();

    const [url, key] = mockCreateClient.mock.calls[0]!;
    const { auth } = optionsPassed();
    expect(url).toBe('https://project.supabase.test');
    expect(key).toBe('sb_publishable_test');
    expect(auth).toMatchObject({
      storageKey: STORAGE_KEY,
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    });

    auth.storage.setItem('some-key', 'value');
    expect(mockStorage.get('some-key')).toBe('value');
    expect(auth.storage.getItem('some-key')).toBe('value');
    auth.storage.removeItem('some-key');
    expect(auth.storage.getItem('some-key')).toBeNull();
  });

  it('refuses to load without the Supabase URL', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;

    expect(() => load()).toThrow('EXPO_PUBLIC_SUPABASE_URL');
  });

  it('refuses to load without the publishable key', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    expect(() => load()).toThrow('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  });

  it('gives up on an Auth request after 10 seconds, so a hung refresh cannot hold the app', async () => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        }),
    );
    load();

    let settled = false;
    const result = optionsPassed()
      .global.fetch('https://project.supabase.test/auth/v1/token')
      .catch((e: unknown) => {
        settled = true;
        return e;
      });

    await jest.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(((await result) as Error).name).toBe('AbortError');
  });

  it("passes auth-js's own abort through", async () => {
    globalThis.fetch = jest.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        }),
    );
    load();
    const controller = new AbortController();

    const result = optionsPassed()
      .global.fetch('https://project.supabase.test/auth/v1/token', { signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();

    expect(((await result) as Error).name).toBe('AbortError');
  });
});

describe('the stored session', () => {
  it('knows who was signed in at launch, before auth-js can remove the session', () => {
    mockStorage.set(STORAGE_KEY, storedSession());

    expect(load().userIdAtLaunch).toBe('user-a');
  });

  it('reads the user of the session in storage now', () => {
    const lib = load();
    expect(lib.storedSessionUserId()).toBeNull();

    mockStorage.set(STORAGE_KEY, storedSession({ user: { id: 'user-b' } }));
    expect(lib.storedSessionUserId()).toBe('user-b');

    lib.removeStoredSession();
    expect(lib.storedSessionUserId()).toBeNull();
  });

  it('treats storage auth-js would reject as no session', () => {
    const lib = load();

    mockStorage.set(STORAGE_KEY, '{not json');
    expect(lib.storedSessionUserId()).toBeNull();

    mockStorage.set(STORAGE_KEY, storedSession({ refresh_token: undefined }));
    expect(lib.storedSessionUserId()).toBeNull();

    mockStorage.set(STORAGE_KEY, storedSession({ user: null }));
    expect(lib.storedSessionUserId()).toBeNull();
  });
});

describe('crypto.getRandomValues', () => {
  it('comes from expo-crypto when the runtime has no crypto, as React Native has none', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    load();

    const installed = (globalThis as unknown as { crypto?: Record<string, unknown> }).crypto;
    expect(installed?.getRandomValues).toBe(mockGetRandomValues);
    // Only getRandomValues. A crypto.subtle without importKey would break auth-js's getClaims.
    expect(installed && 'subtle' in installed).toBe(false);
  });

  it('leaves a runtime crypto alone', () => {
    const existing = { getRandomValues: jest.fn() };
    Object.defineProperty(globalThis, 'crypto', {
      value: existing,
      configurable: true,
      writable: true,
    });

    load();

    expect((globalThis as { crypto?: unknown }).crypto).toBe(existing);
  });
});
