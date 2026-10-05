import type { ErrorCode } from '@momentlens/shared-types';

import type { StoppedReason, WaitingState } from './types';

// The upload queue's state machine, a human-read surface (D-68, D-97). This file is the table in
// docs/ARCHITECTURE.md §4, "What each answer does to a queued photo", for every refusal. A 201 or
// 200 from pre-flight and a 200 from completion are the runner's own success paths.

// D-146's routine calls.
export const FIRST_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 5 * 60_000;
export const MAX_PREPARE_ATTEMPTS = 3;
// After a failure with no answer the whole runner waits this long, so an outage meets one photo
// every 5 seconds rather than every queued photo at once. Each photo keeps its own backoff, so one
// that keeps failing does not hold back the rest.
export const RUNNER_PAUSE_MS = FIRST_RETRY_MS;

// 5 seconds after the first failure, doubling to 5 minutes, with no cap on tries (D-146).
export function backoffDelay(failures: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
}

export type Call = 'preflight' | 'complete';

export type Transition =
  // No answer: offline, a timeout, a 5xx, or a body that did not parse. Same step, after backoff.
  | { type: 'retry' }
  // 401: unchanged, waiting on the session.
  | { type: 'session' }
  // 409 duplicate: leaves the queue with no prompt.
  | { type: 'drop' }
  // 409 album_closed or unverified: waits for S-31's or S-15's release.
  | { type: 'wait'; state: WaitingState }
  | { type: 'stop'; reason: StoppedReason }
  // Completion 409 upload_missing: queued at pre-flight, which resumes the row with fresh URLs.
  | { type: 'resend' }
  // The request was refused on the phone because another account is signed in. Nothing is written.
  | { type: 'cancel' };

const RETRY: Transition = { type: 'retry' };
const stop = (reason: StoppedReason): Transition => ({ type: 'stop', reason });

// Read off the error's fields rather than with instanceof, so this table carries no dependency on
// the API client or Supabase (as lib/query-client.ts reads a refusal).
function answerOf(error: unknown): { status: number | undefined; code: string | undefined } {
  if (typeof error !== 'object' || error === null) return { status: undefined, code: undefined };
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    status: typeof status === 'number' ? status : undefined,
    code: typeof code === 'string' ? code : undefined,
  };
}

// Typed against ErrorCode, so a code the API does not send fails typecheck here.
const is = (code: string | undefined, expected: ErrorCode) => code === expected;

export function transitionFor(call: Call, error: unknown): Transition {
  if (error instanceof Error && error.name === 'AccountChangedError') return { type: 'cancel' };
  const { status, code } = answerOf(error);
  // A 2xx here is one whose body did not parse, such as a captive portal's page.
  if (status === undefined || status >= 500 || status < 300 || status === 408 || status === 429) {
    return RETRY;
  }
  if (status === 401) return { type: 'session' };
  if (status === 400) return stop('invalid_request');
  if (status === 404) return stop('not_found');
  if (status === 403) {
    return call === 'complete' && is(code, 'not_uploader')
      ? stop('not_uploader')
      : stop('not_member');
  }
  if (status === 409 && is(code, 'duplicate')) return { type: 'drop' };
  if (call === 'preflight') {
    if (status === 409 && is(code, 'album_closed')) return { type: 'wait', state: 'waiting_album' };
    if (status === 409 && is(code, 'unverified')) {
      return { type: 'wait', state: 'waiting_verification' };
    }
    if (status === 409 && is(code, 'sub_event_missing')) return stop('sub_event_missing');
    if (status === 422 && is(code, 'event_full')) return stop('event_full');
    if (status === 422 && is(code, 'too_many_unfinished')) return stop('too_many_unfinished');
  } else if (status === 409 && is(code, 'upload_missing')) {
    return { type: 'resend' };
  }
  // A refusal this table does not know is an app bug, which no retry fixes.
  return stop('invalid_request');
}
