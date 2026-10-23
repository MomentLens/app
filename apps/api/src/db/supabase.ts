import { createClient } from '@supabase/supabase-js';

import type { Env } from '../config';

// How long the API waits for one Supabase request. The phone gives up after 10 s, so a stalled
// call fails here first.
export const SUPABASE_TIMEOUT_MS = 3000;

// A Supabase client for code running on a server. There is no user session, so nothing is
// persisted or refreshed. The RLS test builds its clients here too, so it exercises the client the
// API uses, including with the publishable key it must never be able to read with. Only the API
// passes `timeoutMs`: the test reaches the dev project from a CI runner, where one call can take
// longer than the API's deadline.
export function createServerClient(
  url: string,
  key: string,
  { timeoutMs }: { timeoutMs?: number } = {},
) {
  return createClient(url, key, {
    // The phone owns retries. Hidden SDK retries can outlive its request deadline.
    db: { retry: false },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return fetch(input, {
          ...init,
          signal: AbortSignal.any([
            ...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]),
            ...(caller ? [caller] : []),
          ]),
        });
      },
    },
  });
}

// The client's own inferred type. The bare SupabaseClient type widens one of its generics to
// any, which the type-checked lint rules reject as an unsafe conversion.
export type Supabase = ReturnType<typeof createServerClient>;

// The API's one Supabase client. It holds the secret key, so RLS never applies to its queries
// and every authorization decision lives in the service layer (D-73).
export function createSupabase(env: Env): Supabase {
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    timeoutMs: SUPABASE_TIMEOUT_MS,
  });
}
