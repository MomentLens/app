import { HealthResponse } from '@momentlens/shared-types';

// The app's one typed client for the MomentLens API (Handbook §4). Every body is parsed against
// its shared schema before a screen sees it, so a contract mismatch arrives as an error here
// rather than as undefined fields in the UI.

// Read with dot notation on purpose. Expo inlines EXPO_PUBLIC_ variables at build time only when
// they are referenced this way, never through destructuring or brackets.
export const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Longer than the API's own 3-second database timeout plus a slow mobile round trip.
const REQUEST_TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  if (!API_URL) {
    throw new ApiError('EXPO_PUBLIC_API_URL is not set. Add it to apps/mobile/.env, then reload.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);
  try {
    return await fetch(`${API_URL.replace(/\/+$/, '')}${path}`, {
      headers: { Accept: 'application/json' },
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

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await request('/health', signal);
  // 503 is an answer, not a failure. The API is up and reporting that the database is not.
  if (response.status !== 200 && response.status !== 503) {
    throw new ApiError(`GET /health answered HTTP ${response.status}.`, response.status);
  }
  // A captive portal on venue WiFi can answer 200 with an HTML page, so JSON is not assumed.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('GET /health answered with something other than JSON.', response.status);
  }
  const parsed = HealthResponse.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'GET /health answered with a body this app does not understand.',
      response.status,
    );
  }
  return parsed.data;
}
