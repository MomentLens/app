import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  AuthApiError,
  AuthRefreshDiscardedError,
  AuthRetryableFetchError,
} from '@supabase/supabase-js';

import type * as ApiModule from '@/lib/api';

type Api = typeof ApiModule;

type SessionResult = {
  data: { session: { access_token: string } | null };
  error: Error | null;
};

// The three auth-js calls api.ts makes. Each test says what they answer.
const mockAuth = {
  getSession: jest.fn<() => Promise<SessionResult>>(),
  refreshSession: jest.fn<() => Promise<SessionResult>>(),
  signOut: jest.fn((_options?: { scope?: string }) => Promise.resolve({ error: null })),
};
jest.mock('@/lib/supabase', () => ({ supabase: { auth: mockAuth } }));

const BASE_URL = 'https://api.example.test/';
const originalFetch = globalThis.fetch;

// api.ts reads EXPO_PUBLIC_API_URL once, when the module loads, so each test loads its own copy
// with the environment it needs. It loads through jest.requireActual inside isolateModules rather
// than a dynamic import(), which babel-preset-expo leaves untransformed and Jest's CommonJS
// runtime cannot run.
function loadApi(url: string | undefined): Api {
  if (url === undefined) {
    delete process.env.EXPO_PUBLIC_API_URL;
  } else {
    process.env.EXPO_PUBLIC_API_URL = url;
  }
  let api: Api | undefined;
  jest.isolateModules(() => {
    api = jest.requireActual<Api>('@/lib/api');
  });
  if (api === undefined) {
    throw new Error('lib/api did not load');
  }
  return api;
}

function healthBody(status: 'ok' | 'degraded', database: 'ok' | 'error') {
  return { status, database, checkedAt: new Date().toISOString() };
}

function answers(status: number, body: unknown) {
  return jest.fn<typeof fetch>(() =>
    Promise.resolve({ status, json: () => Promise.resolve(body) } as unknown as Response),
  );
}

// What a captive portal or an error page looks like to the client: a status, and a body that is
// not JSON.
function answersWithHtml(status: number) {
  return jest.fn<typeof fetch>(() =>
    Promise.resolve({
      status,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response),
  );
}

// Never answers, but rejects the way a real fetch does once its signal aborts.
function neverAnswers() {
  return jest.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      }),
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
  jest.clearAllMocks();
  delete process.env.EXPO_PUBLIC_API_URL;
});

describe('getHealth', () => {
  it('returns the body for 200 and does not double the trailing slash in the base URL', async () => {
    const fetchMock = answers(200, healthBody('ok', 'ok'));
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.getHealth()).resolves.toMatchObject({ status: 'ok', database: 'ok' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/health');
  });

  it('returns a degraded body for 503 instead of throwing, because the API did answer', async () => {
    globalThis.fetch = answers(503, healthBody('degraded', 'error'));
    const api = loadApi(BASE_URL);

    await expect(api.getHealth()).resolves.toMatchObject({
      status: 'degraded',
      database: 'error',
    });
  });

  it('throws ApiError carrying the status for any other status', async () => {
    globalThis.fetch = answersWithHtml(502);
    const api = loadApi(BASE_URL);

    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).status).toBe(502);
  });

  it('throws ApiError when a 200 is not JSON, which is what a captive portal sends', async () => {
    globalThis.fetch = answersWithHtml(200);
    const api = loadApi(BASE_URL);

    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as Error).message).toBe('GET /health answered with something other than JSON.');
  });

  it('throws ApiError when the JSON does not match the shared schema', async () => {
    globalThis.fetch = answers(200, { status: 'fine' });
    const api = loadApi(BASE_URL);

    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as Error).message).toBe(
      'GET /health answered with a body this app does not understand.',
    );
  });

  it('throws ApiError when the request cannot reach the API', async () => {
    globalThis.fetch = jest.fn<typeof fetch>(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    const api = loadApi(BASE_URL);

    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
  });

  it('times out with ApiError at 10 seconds, not before', async () => {
    jest.useFakeTimers();
    globalThis.fetch = neverAnswers();
    const api = loadApi(BASE_URL);

    let settled = false;
    const result = api.getHealth().catch((e: unknown) => {
      settled = true;
      return e;
    });

    await jest.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as Error).message).toBe('The API did not answer within 10 seconds.');
  });

  it('hands a caller abort back as the AbortError itself, not as an ApiError', async () => {
    globalThis.fetch = neverAnswers();
    const api = loadApi(BASE_URL);
    const controller = new AbortController();

    const result = api.getHealth(controller.signal).catch((e: unknown) => e);
    controller.abort();
    const error = await result;

    expect(error).not.toBeInstanceOf(api.ApiError);
    expect((error as Error).name).toBe('AbortError');
  });

  it('throws ApiError before making any request when EXPO_PUBLIC_API_URL is missing', async () => {
    const fetchMock = answers(200, healthBody('ok', 'ok'));
    globalThis.fetch = fetchMock;
    const api = loadApi(undefined);

    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getMyProfile', () => {
  const USER_ID = '5f3a4c2e-8b1d-4e6f-9a7c-2d1e0b3f4a5c';
  const profile = { userId: USER_ID, fullName: 'Ayesha Khan', avatar: null };

  function signedIn(accessToken: string): SessionResult {
    return { data: { session: { access_token: accessToken } }, error: null };
  }

  function noSession(error: Error | null): SessionResult {
    return { data: { session: null }, error };
  }

  function noSessionBody() {
    return { error: { code: 'no_session', message: 'Missing, invalid or expired access token' } };
  }

  // Answers each call with the next status and body in the list.
  function answersInTurn(...answers: [number, unknown][]) {
    let call = 0;
    return jest.fn<typeof fetch>(() => {
      const [status, body] = answers[Math.min(call, answers.length - 1)]!;
      call += 1;
      return Promise.resolve({
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    });
  }

  function authorizationOf(fetchMock: ReturnType<typeof answersInTurn>, call: number) {
    const init = fetchMock.mock.calls[call]?.[1];
    return (init?.headers as Record<string, string> | undefined)?.Authorization;
  }

  it('sends the access token as a Bearer header and returns the parsed profile', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([200, profile]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.getMyProfile()).resolves.toEqual(profile);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/profiles/me');
    expect(authorizationOf(fetchMock, 0)).toBe('Bearer token-1');
  });

  it('refreshes once on a 401 and retries once with the new token', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(signedIn('token-2'));
    const fetchMock = answersInTurn([401, noSessionBody()], [200, profile]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.getMyProfile()).resolves.toEqual(profile);
    expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);
    expect(authorizationOf(fetchMock, 1)).toBe('Bearer token-2');
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('signs this device out when Supabase rejects the refresh token, which shows Forced Logout', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(
      noSession(new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found')),
    );
    const fetchMock = answersInTurn([401, noSessionBody()]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('no_session');
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never signs out when the refresh fails for lack of network', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(
      noSession(new AuthRetryableFetchError('Network request failed', 0)),
    );
    globalThis.fetch = answersInTurn([401, noSessionBody()]);
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).status).toBeUndefined();
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('never signs out when Supabase rate-limits the refresh, which says nothing about the token', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(
      noSession(new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit')),
    );
    globalThis.fetch = answersInTurn([401, noSessionBody()]);
    const api = loadApi(BASE_URL);

    await expect(api.getMyProfile()).rejects.toBeInstanceOf(api.ApiError);
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('shows an error without signing out when the retry is still 401', async () => {
    // Supabase accepted the refresh, so the session is alive and the API is the one refusing it,
    // as it does for a token with no profile row (S-01 card, decided at build mobile).
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(signedIn('token-2'));
    const fetchMock = answersInTurn([401, noSessionBody()], [401, noSessionBody()]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).status).toBe(401);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('no_session');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('retries with the session another refresh left when this one was discarded', async () => {
    mockAuth.getSession
      .mockResolvedValueOnce(signedIn('token-1'))
      .mockResolvedValueOnce(signedIn('token-3'));
    mockAuth.refreshSession.mockResolvedValue(noSession(new AuthRefreshDiscardedError()));
    const fetchMock = answersInTurn([401, noSessionBody()], [200, profile]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.getMyProfile()).resolves.toEqual(profile);
    expect(authorizationOf(fetchMock, 1)).toBe('Bearer token-3');
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('throws a network ApiError without calling the API when the token cannot be refreshed offline', async () => {
    mockAuth.getSession.mockResolvedValue(
      noSession(new AuthRetryableFetchError('Network request failed', 0)),
    );
    const fetchMock = answersInTurn([200, profile]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).status).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });

  it('throws no_session without calling the API when nobody is signed in', async () => {
    mockAuth.getSession.mockResolvedValue(noSession(null));
    const fetchMock = answersInTurn([200, profile]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('no_session');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the code from an ErrorResponse body', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([
      500,
      { error: { code: 'internal_error', message: 'Something went wrong' } },
    ]);
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).status).toBe(500);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('internal_error');
  });

  it('falls back to the status when the error body carries a code this build has never heard of', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([409, { error: { code: 'from_the_future', message: '' } }]);
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).status).toBe(409);
    expect((error as InstanceType<Api['ApiError']>).code).toBeUndefined();
  });

  it('throws ApiError when a 200 body does not match ProfileResponse', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([200, { userId: 'not-a-uuid', fullName: '', avatar: null }]);
    const api = loadApi(BASE_URL);

    const error = await api.getMyProfile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as Error).message).toBe(
      'GET /profiles/me answered with a body this app does not understand.',
    );
  });
});
