import { createClient } from '@supabase/supabase-js';

// How long the API waits for one Auth request. The phone gives up after 10 s, so a stalled
// call fails here first.
export const SUPABASE_TIMEOUT_MS = 3000;

// A Supabase Auth client for checking access tokens. There is no user session, so nothing is
// persisted or refreshed. The API reads and writes data through its SQL pool instead (db/sql.ts,
// D-164). The auth tests build their clients here too, so they exercise the client the API uses.
// Only the API passes `timeoutMs`: a test reaches Auth from a CI runner, where one call can take
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
