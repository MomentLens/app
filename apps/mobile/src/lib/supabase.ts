import { createClient } from '@supabase/supabase-js';
import { getRandomValues } from 'expo-crypto';
import { AppState } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

// The app's Supabase client, for Auth and nothing else until Realtime on `media` and `event` joins
// it (root invariant 14). Every table read and write goes through the API.

// Read with dot notation, the only form Expo inlines at build time. Anyone holding the APK can read
// both, which is fine for the publishable key and never fine for the secret one.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL is not set. Add it to apps/mobile/.env, then reload.');
}
if (!SUPABASE_PUBLISHABLE_KEY) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set. Add it to apps/mobile/.env, then reload.',
  );
}

// Where the recovery email sends the user. It has to match the entry in both projects' redirect
// allow-list exactly (arch §7), so it is written out rather than built with expo-linking.
export const RESET_PASSWORD_URL = 'momentlens://reset-password';

// auth-js makes the reset link's PKCE verifier with crypto.getRandomValues, and falls back to
// Math.random when there is no `crypto`, which React Native does not have. Only getRandomValues is
// installed. Without crypto.subtle the code challenge is `plain`, which protects this flow as well
// as S256 would, because the challenge goes to Supabase in a POST over TLS and never through a URL.
// A crypto.subtle with only digest() would be worse than none: auth-js's getClaims would take it
// for Web Crypto and call an importKey that is not there.
const runtime = globalThis as { crypto?: { getRandomValues?: unknown } };
if (runtime.crypto === undefined) {
  runtime.crypto = { getRandomValues };
} else if (typeof runtime.crypto.getRandomValues !== 'function') {
  runtime.crypto.getRandomValues = getRandomValues;
}

// The session lives in MMKV (D-109). The key is ours, not auth-js's default, so this file can read
// the stored session itself below.
const STORAGE_KEY = 'momentlens-auth';
const mmkv = createMMKV({ id: 'supabase-auth' });

const authStorage = {
  getItem: (key: string) => mmkv.getString(key) ?? null,
  setItem: (key: string, value: string) => mmkv.set(key, value),
  removeItem: (key: string) => {
    mmkv.remove(key);
  },
};

// The user of the session in storage, or null when storage holds none or holds something auth-js
// would throw away. The checks match auth-js 2.116.0's _isValidSession, plus the user id this app
// needs.
export function storedSessionUserId(): string | null {
  const raw = mmkv.getString(STORAGE_KEY);
  if (raw === undefined) {
    return null;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) {
    return null;
  }
  const session = stored as Record<string, unknown>;
  const user = session.user as Record<string, unknown> | null | undefined;
  const complete =
    typeof session.access_token === 'string' &&
    typeof session.refresh_token === 'string' &&
    typeof session.expires_at === 'number' &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.id === 'string';
  return complete ? (user.id as string) : null;
}

// Removes the stored session without asking auth-js. Only logout uses this, for the one case where
// auth-js's own signOut leaves the session behind (features/auth/logout.ts).
export function removeStoredSession(): void {
  mmkv.remove(STORAGE_KEY);
}

// Who was signed in when this JavaScript loaded, read before the client below exists. auth-js
// removes a session whose refresh token Supabase rejects while it starts up, and this is how the
// app knows there was one to remove: that launch shows Forced Logout rather than Login.
export const userIdAtLaunch = storedSessionUserId();

// auth-js sets no timeout of its own, so a refresh on venue Wi-Fi that never answers would leave
// the session unresolved for as long as the socket stays open. The API client's 10 seconds apply
// here too. auth-js reports the abort as a network failure, which never ends a session.
const AUTH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  const outer = init?.signal;
  const forwardAbort = () => controller.abort();
  if (outer?.aborted) {
    controller.abort();
  } else {
    outer?.addEventListener('abort', forwardAbort);
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forwardAbort);
  });
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: authStorage,
    storageKey: STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    // The reset link arrives as a deep link, which the reset screen hands to
    // exchangeCodeForSession itself. There is no browser URL to read.
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
  global: { fetch: fetchWithTimeout },
});

// auth-js refreshes on a timer. Supabase's React Native guidance runs that timer only while the
// app is in the foreground; coming back to it refreshes straight away if the token has expired.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
});
