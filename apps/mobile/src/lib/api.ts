import {
  ErrorResponse,
  HealthResponse,
  ProfileResponse,
  type ErrorCode,
} from '@momentlens/shared-types';
import {
  isAuthApiError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

// The app's one typed client for the MomentLens API (Handbook §4). Every body is parsed against
// its shared schema before a screen sees it, so a contract mismatch arrives as an error here
// rather than as undefined fields in the UI.

// Read with dot notation on purpose. Expo inlines EXPO_PUBLIC_ variables at build time only when
// they are referenced this way, never through destructuring or brackets.
export const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Longer than the API's own 3-second database timeout plus a slow mobile round trip.
const REQUEST_TIMEOUT_MS = 10_000;

const AUTH_UNREACHABLE = 'Could not reach Supabase Auth to refresh the session.';

export class ApiError extends Error {
  readonly status: number | undefined;
  // The ErrorResponse code, when the body carried one this build knows. A screen switches on it,
  // or on `status` when it is missing (Handbook §5.3).
  readonly code: ErrorCode | undefined;

  constructor(message: string, status?: number, code?: ErrorCode) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  accessToken?: string;
}

async function request(path: string, { signal, accessToken }: RequestOptions = {}) {
  if (!API_URL) {
    throw new ApiError('EXPO_PUBLIC_API_URL is not set. Add it to apps/mobile/.env, then reload.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (accessToken !== undefined) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  try {
    return await fetch(`${API_URL.replace(/\/+$/, '')}${path}`, {
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    // The caller cancelled, for example because the screen went away. TanStack Query expects the
    // abort itself back, not a failure it would show or retry.
    if (signal?.aborted) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ApiError(`The API did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new ApiError('Could not reach the API. Check the connection and the API address.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// The signed-in user's access token. getSession refreshes it first when it is within 90 seconds of
// expiring, so the API rarely sees an expired one.
async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (data.session) {
    return data.session.access_token;
  }
  // Offline with an expired token: the session is still stored and still good, it just cannot be
  // refreshed yet. Nobody is logged out for that (D-109).
  if (isAuthRetryableFetchError(error)) {
    throw new ApiError(AUTH_UNREACHABLE);
  }
  throw new ApiError('Nobody is signed in.', 401, 'no_session');
}

// True when Supabase answered the refresh and refused it: a 4xx other than a rate limit, the same
// rule the API applies to access tokens (apps/api/src/middleware/auth.ts). A 5xx, a 429 or a
// network failure says nothing about the token.
function refreshWasRejected(error: unknown): boolean {
  if (!isAuthApiError(error)) {
    return false;
  }
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

// After a 401, a fresh access token for the one retry, or an ApiError.
async function refreshedAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  if (data.session) {
    return data.session.access_token;
  }
  if (refreshWasRejected(error)) {
    // The session is dead, the one case that shows Forced Logout (D-109). auth-js removes the
    // session itself only once the access token has also expired, so it is signed out here for
    // the other case. The SIGNED_OUT that follows shows Forced Logout (features/auth/session.ts).
    await supabase.auth.signOut({ scope: 'local' });
    throw new ApiError('Supabase rejected the refresh token.', 401, 'no_session');
  }
  if (isAuthRefreshDiscardedError(error)) {
    // Another refresh or a sign-out changed the stored session while this refresh was in flight.
    // Whatever it left is the current answer.
    return accessToken();
  }
  if (isAuthRetryableFetchError(error)) {
    throw new ApiError(AUTH_UNREACHABLE);
  }
  throw new ApiError('Nobody is signed in.', 401, 'no_session');
}

// A request on behalf of the signed-in user. On a 401 it refreshes the session once and retries
// once (D-109). A second 401 goes back to the caller as it stands: Supabase accepted the refresh,
// so the session is alive and nobody is logged out for it (S-01 card, decided at build mobile).
async function authenticatedRequest(path: string, signal?: AbortSignal): Promise<Response> {
  const first = await request(path, { signal, accessToken: await accessToken() });
  if (first.status !== 401) {
    return first;
  }
  return request(path, { signal, accessToken: await refreshedAccessToken() });
}

// A body that is not ErrorResponse still says what kind of failure it was through its status. So
// does one with a code this build has never heard of (packages/shared-types errors.ts).
async function errorFrom(what: string, response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = ErrorResponse.safeParse(body);
  return new ApiError(
    `${what} answered HTTP ${response.status}.`,
    response.status,
    parsed.success ? parsed.data.error.code : undefined,
  );
}

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function parseBody<T>(what: string, response: Response, schema: Schema<T>): Promise<T> {
  // A captive portal on venue WiFi can answer 200 with an HTML page, so JSON is not assumed.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`${what} answered with something other than JSON.`, response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      `${what} answered with a body this app does not understand.`,
      response.status,
    );
  }
  return parsed.data;
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await request('/health', { signal });
  // 503 is an answer, not a failure. The API is up and reporting that the database is not.
  if (response.status !== 200 && response.status !== 503) {
    throw await errorFrom('GET /health', response);
  }
  return parseBody('GET /health', response, HealthResponse);
}

// The caller's own profile (D-109).
export async function getMyProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  const response = await authenticatedRequest('/profiles/me', signal);
  if (response.status !== 200) {
    throw await errorFrom('GET /profiles/me', response);
  }
  return parseBody('GET /profiles/me', response, ProfileResponse);
}
