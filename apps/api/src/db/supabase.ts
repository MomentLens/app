import { createClient } from '@supabase/supabase-js';

import type { Env } from '../config';

// A Supabase client for code running on a server. There is no user session, so nothing is
// persisted or refreshed. The RLS test builds its clients here too, so it exercises exactly the
// client the API uses, including with the publishable key it must never be able to read with.
export function createServerClient(url: string, key: string) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// The client's own inferred type. The bare SupabaseClient type widens one of its generics to
// any, which the type-checked lint rules reject as an unsafe conversion.
export type Supabase = ReturnType<typeof createServerClient>;

// The API's one Supabase client. It holds the secret key, so RLS never applies to its queries
// and every authorization decision lives in the service layer (D-73).
export function createSupabase(env: Env): Supabase {
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
}
