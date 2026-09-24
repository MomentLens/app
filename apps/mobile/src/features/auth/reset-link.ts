import {
  isAuthPKCECodeVerifierMissingError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

// Exchanging the code a reset link carries, for src/app/reset-password.tsx. The exchange needs the
// verifier resetPasswordForEmail left in this phone's storage, so it works only on the phone that
// asked (D-109).

export type ExchangeResult = 'ok' | 'expired' | 'otherPhone' | 'offline';

export function exchangeResult(error: unknown): ExchangeResult {
  if (error === null) {
    return 'ok';
  }
  if (isAuthPKCECodeVerifierMissingError(error)) {
    return 'otherPhone';
  }
  // The verifier is gone now too, so this link is spent even though the request may never have
  // reached Supabase.
  if (isAuthRetryableFetchError(error)) {
    return 'offline';
  }
  // Already used, expired, or older than a link sent after it.
  return 'expired';
}

// auth-js deletes the verifier after any exchange, failed or not, so a second exchange of the same
// code would find none and wrongly send the user to another phone. Each code is exchanged once per
// launch, and a remount reuses the answer.
const exchanges = new Map<string, Promise<ExchangeResult>>();

export function exchangeOnce(code: string): Promise<ExchangeResult> {
  let pending = exchanges.get(code);
  if (pending === undefined) {
    pending = supabase.auth.exchangeCodeForSession(code).then(
      ({ error }) => exchangeResult(error),
      (): ExchangeResult => 'expired',
    );
    exchanges.set(code, pending);
  }
  return pending;
}
