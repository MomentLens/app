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

describe('pending approval endpoints', () => {
  const eventId = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const userId = '11111111-1111-4111-8111-111111111111';
  const targets = [{ userId, expectedVersion: 'opaque-1' }];
  const membership = { userId, role: 'guest', status: 'active', accessVersion: 'opaque-2' };
  function signIn() {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
  }
  it('encodes an opaque list cursor and parses the available Guest places', async () => {
    signIn();
    const body = { requests: [], nextCursor: null, guestPlacesLeft: 0 };
    const fetched = answers(200, body);
    globalThis.fetch = fetched;
    await expect(
      loadApi(BASE_URL).listPendingRequests(eventId, { cursor: 'a/b+=' }),
    ).resolves.toEqual(body);
    expect(fetched.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${eventId}/join-requests?cursor=a%2Fb%2B%3D`,
    );
    expect(fetched.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it.each(['approveRequests', 'rejectRequests', 'blockRequest'] as const)(
    'sends %s once with the loaded version and parses its response',
    async (method) => {
      signIn();
      const status =
        method === 'approveRequests'
          ? 'active'
          : method === 'rejectRequests'
            ? 'removed'
            : 'blocked';
      const result =
        method === 'blockRequest'
          ? { membership: { ...membership, status } }
          : { memberships: [{ ...membership, status }] };
      const fetched = answers(200, result);
      globalThis.fetch = fetched;
      const api = loadApi(BASE_URL);
      await expect(
        method === 'blockRequest'
          ? api.blockRequest(eventId, userId, { expectedVersion: 'opaque-1' })
          : api[method](eventId, { targets }),
      ).resolves.toEqual(result);
      expect(fetched.mock.calls[0]?.[0]).toBe(
        `https://api.example.test/events/${eventId}/join-requests/${method === 'blockRequest' ? `${userId}/block` : method === 'approveRequests' ? 'approve' : 'reject'}`,
      );
      expect(fetched.mock.calls[0]?.[1]?.method).toBe('POST');
      expect(JSON.parse(fetched.mock.calls[0]?.[1]?.body as string)).toEqual(
        method === 'blockRequest' ? { expectedVersion: 'opaque-1' } : { targets },
      );
      expect(fetched).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['approveRequests', 'rejectRequests', 'blockRequest'] as const)(
    'allows %s one resend only after Auth refuses it with 401',
    async (method) => {
      signIn();
      mockAuth.refreshSession.mockResolvedValue({
        data: { session: { access_token: 'fresh' } },
        error: null,
      });
      const status =
        method === 'approveRequests'
          ? 'active'
          : method === 'rejectRequests'
            ? 'removed'
            : 'blocked';
      const result =
        method === 'blockRequest'
          ? { membership: { ...membership, status } }
          : { memberships: [{ ...membership, status }] };
      const fetched = answers(401, { error: { code: 'no_session', message: 'expired' } });
      fetched
        .mockImplementationOnce(answers(401, { error: { code: 'no_session', message: 'expired' } }))
        .mockImplementationOnce(answers(200, result));
      globalThis.fetch = fetched;
      const api = loadApi(BASE_URL);
      await (method === 'blockRequest'
        ? api.blockRequest(eventId, userId, { expectedVersion: 'opaque-1' })
        : api[method](eventId, { targets }));
      expect(fetched).toHaveBeenCalledTimes(2);
      expect(fetched.mock.calls[1]?.[1]?.body).toBe(fetched.mock.calls[0]?.[1]?.body);
      expect((fetched.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe(
        'Bearer fresh',
      );
    },
  );
  it.each([409, 422, 500])('does not resend an approval after a %s answer', async (status) => {
    signIn();
    const fetched = answers(status, {
      error: {
        code:
          status === 409 ? 'membership_changed' : status === 422 ? 'event_full' : 'internal_error',
        message: 'x',
      },
    });
    globalThis.fetch = fetched;
    await expect(loadApi(BASE_URL).approveRequests(eventId, { targets })).rejects.toMatchObject({
      status,
    });
    expect(fetched).toHaveBeenCalledTimes(1);
  });
  it('treats a malformed success as uncertain and sends no second write', async () => {
    signIn();
    const fetched = answers(200, { memberships: [{ ...membership, status: 'pending' }] });
    globalThis.fetch = fetched;
    await expect(loadApi(BASE_URL).approveRequests(eventId, { targets })).rejects.toMatchObject({
      status: 200,
    });
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});

describe('attendee endpoints', () => {
  const eventId = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const userId = '11111111-1111-4111-8111-111111111111';
  const target = {
    userId,
    fullName: 'Hamza Siddiqui',
    role: 'guest',
    requestedAt: '2026-10-02T13:00:00.000Z',
    accessVersion: 'opaque-1',
    avatar: null,
  };

  function signIn() {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
  }

  it('encodes literal search text and opaque cursors without changing them', async () => {
    signIn();
    const fetchMock = answers(200, { attendees: [target], nextCursor: 'next' });
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);
    await expect(
      api.listAttendees(eventId, { search: '% &Ali_+', role: 'guest', cursor: 'a/b+=' }),
    ).resolves.toEqual({ attendees: [target], nextCursor: 'next' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${eventId}/attendees?search=%25%20%26Ali_%2B&role=guest&cursor=a%2Fb%2B%3D`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each(['changeAttendeeRole', 'removeAttendee', 'blockAttendee'] as const)(
    'sends %s with only the action body and parses the shared response',
    async (method) => {
      signIn();
      const status =
        method === 'removeAttendee' ? 'removed' : method === 'blockAttendee' ? 'blocked' : 'active';
      const role = method === 'changeAttendeeRole' ? 'photographer' : 'guest';
      const membership = { userId, role, status, accessVersion: 'opaque-2' };
      const fetchMock = answers(200, { membership });
      globalThis.fetch = fetchMock;
      const api = loadApi(BASE_URL);
      const body =
        method === 'changeAttendeeRole'
          ? { expectedVersion: 'opaque-1', role: 'photographer' as const }
          : { expectedVersion: 'opaque-1' };
      const result =
        method === 'changeAttendeeRole'
          ? await api.changeAttendeeRole(eventId, userId, { ...body, role: 'photographer' })
          : await api[method](eventId, userId, body);
      expect(result).toEqual({ membership });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `https://api.example.test/events/${eventId}/attendees/${userId}/${method === 'changeAttendeeRole' ? 'role' : method === 'removeAttendee' ? 'remove' : 'block'}`,
      );
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe(
        method === 'changeAttendeeRole' ? 'PATCH' : 'POST',
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(body);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  // A 401 comes from the auth check before the handler runs, so nothing was written and the one
  // resend after an Auth refresh is safe. It is not a retry of an uncertain write (D-143).
  it.each(['changeAttendeeRole', 'removeAttendee', 'blockAttendee'] as const)(
    'resends %s once after a 401 Auth refresh with the same version',
    async (method) => {
      signIn();
      mockAuth.refreshSession.mockResolvedValue({
        data: { session: { access_token: 'fresh' } },
        error: null,
      });
      const status =
        method === 'removeAttendee' ? 'removed' : method === 'blockAttendee' ? 'blocked' : 'active';
      const membership = { userId, role: 'guest', status, accessVersion: 'opaque-2' };
      const replies = [
        { status: 401, body: { error: { code: 'no_session', message: 'No session' } } },
        { status: 200, body: { membership } },
      ];
      const fetchMock = jest.fn<typeof fetch>(() => {
        const reply = replies.shift()!;
        return Promise.resolve({
          status: reply.status,
          json: () => Promise.resolve(reply.body),
        } as unknown as Response);
      });
      globalThis.fetch = fetchMock;
      const api = loadApi(BASE_URL);
      const result =
        method === 'changeAttendeeRole'
          ? await api.changeAttendeeRole(eventId, userId, {
              expectedVersion: 'opaque-1',
              role: 'guest',
            })
          : await api[method](eventId, userId, { expectedVersion: 'opaque-1' });
      expect(result).toEqual({ membership });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockAuth.refreshSession).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
      expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe(
        'Bearer fresh',
      );
    },
  );

  it('does not resend an attendee write after any answer but a 401', async () => {
    signIn();
    const fetchMock = answers(500, { error: { code: 'internal_error', message: 'x' } });
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);
    await expect(
      api.removeAttendee(eventId, userId, { expectedVersion: 'opaque-1' }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps membership_changed for the action layer and hides the server message', async () => {
    signIn();
    globalThis.fetch = answers(409, {
      error: { code: 'membership_changed', message: 'private diagnostic' },
    });
    const api = loadApi(BASE_URL);
    await expect(
      api.removeAttendee(eventId, userId, { expectedVersion: 'old' }),
    ).rejects.toMatchObject({ code: 'membership_changed', status: 409 });
    await expect(
      api.removeAttendee(eventId, userId, { expectedVersion: 'old' }),
    ).rejects.not.toThrow('private diagnostic');
  });

  it('rejects an unrecognized success body rather than assuming a write failed', async () => {
    signIn();
    globalThis.fetch = answers(200, { membership: { userId } });
    const api = loadApi(BASE_URL);
    await expect(
      api.blockAttendee(eventId, userId, { expectedVersion: 'old' }),
    ).rejects.toMatchObject({ status: 200 });
  });
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
    // Nothing reached the API, so nothing it would have written can have landed.
    expect((error as InstanceType<Api['ApiError']>).timedOut).toBe(false);
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
    // The request went out, so a write may have landed (features/manage/settings.ts saveProblem).
    expect((error as InstanceType<Api['ApiError']>).timedOut).toBe(true);
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

describe('event endpoints', () => {
  const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const UPLOAD_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
  const event = {
    id: EVENT_ID,
    name: "Ayesha & Omar's Wedding",
    type: 'wedding',
    role: 'admin',
    cover: null,
    startsAt: '2026-10-03T13:00:00.000Z',
    endsAt: '2026-10-03T18:00:00.000Z',
    archivedAt: null,
  };
  const createRequest = {
    requestId: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
    name: "Ayesha & Omar's Wedding",
    type: 'wedding' as const,
    approvalMode: 'auto' as const,
    venues: [{ name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 }],
    subEvents: [
      {
        name: 'Nikkah',
        startsAt: '2026-10-03T13:00:00.000Z',
        endsAt: '2026-10-03T18:00:00.000Z',
        venueIndex: 0,
        verificationRadiusM: 200,
      },
    ],
  };

  function signedIn(accessToken: string): SessionResult {
    return { data: { session: { access_token: accessToken } }, error: null };
  }

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

  function initOf(fetchMock: ReturnType<typeof answersInTurn>, call: number) {
    return fetchMock.mock.calls[call]?.[1] ?? {};
  }

  function headersOf(fetchMock: ReturnType<typeof answersInTurn>, call: number) {
    return (initOf(fetchMock, call).headers ?? {}) as Record<string, string>;
  }

  function errorBody(code: string) {
    return { error: { code, message: 'refused' } };
  }

  it('POSTs the create request as JSON with the access token and returns the new event', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([201, { event }]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.createEvent(createRequest)).resolves.toEqual({ event });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/events');
    expect(initOf(fetchMock, 0).method).toBe('POST');
    expect(headersOf(fetchMock, 0)).toMatchObject({
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual(createRequest);
  });

  it('accepts a 200, which is the API returning the first event for a repeated requestId', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([200, { event }]);
    const api = loadApi(BASE_URL);

    await expect(api.createEvent(createRequest)).resolves.toEqual({ event });
  });

  it('resends the same body, requestId included, when it retries after a 401', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(signedIn('token-2'));
    const fetchMock = answersInTurn([401, errorBody('no_session')], [201, { event }]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.createEvent(createRequest)).resolves.toEqual({ event });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(initOf(fetchMock, 1).method).toBe('POST');
    expect(initOf(fetchMock, 1).body).toBe(initOf(fetchMock, 0).body);
    expect(headersOf(fetchMock, 1).Authorization).toBe('Bearer token-2');
  });

  it('throws invalid_request for a 400, so the wizard can say the details were refused', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([400, errorBody('invalid_request')]);
    const api = loadApi(BASE_URL);

    const error = await api.createEvent(createRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).status).toBe(400);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('invalid_request');
  });

  it('throws duplicate for a 409 and never reads an event out of it', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([409, errorBody('duplicate')]);
    const api = loadApi(BASE_URL);

    const error = await api.createEvent(createRequest).catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('duplicate');
  });

  it('GETs the caller events and returns them parsed', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([200, { events: [event], joinRequests: [] }]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.listEvents()).resolves.toEqual({ events: [event], joinRequests: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/events');
    expect(initOf(fetchMock, 0).method).toBe('GET');
    expect(initOf(fetchMock, 0).body).toBeUndefined();
  });

  it('refuses a list whose cover has no cache key, since the app never caches under the URL', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([
      200,
      {
        events: [{ ...event, cover: { url: 'https://r2.example.test/a.jpg' } }],
        joinRequests: [],
      },
    ]);
    const api = loadApi(BASE_URL);

    await expect(api.listEvents()).rejects.toBeInstanceOf(api.ApiError);
  });

  it('asks for a cover upload with a bodyless POST on the event path', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const upload = { uploadId: UPLOAD_ID, uploadUrl: 'https://r2.example.test/put?sig=1' };
    const fetchMock = answersInTurn([200, upload]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.createCoverUpload(EVENT_ID)).resolves.toEqual(upload);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${EVENT_ID}/cover-upload`,
    );
    expect(initOf(fetchMock, 0).method).toBe('POST');
    expect(initOf(fetchMock, 0).body).toBeUndefined();
    expect(headersOf(fetchMock, 0)['Content-Type']).toBeUndefined();
  });

  it('throws wrong_role when a member who is not the Admin asks for a cover upload', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([403, errorBody('wrong_role')]);
    const api = loadApi(BASE_URL);

    const error = await api.createCoverUpload(EVENT_ID).catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('wrong_role');
  });

  it('sets the cover by sending the uploadId alone, never a key or a URL (root invariant 12)', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const cover = { url: 'https://r2.example.test/get?sig=2', cacheKey: 'events/x/cover_y.jpg' };
    const fetchMock = answersInTurn([200, { cover }]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.setEventCover(EVENT_ID, UPLOAD_ID)).resolves.toEqual({ cover });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.example.test/events/${EVENT_ID}/cover`);
    expect(initOf(fetchMock, 0).method).toBe('PUT');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ uploadId: UPLOAD_ID });
  });

  it('throws upload_missing when the API cannot find the uploaded cover in R2', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([409, errorBody('upload_missing')]);
    const api = loadApi(BASE_URL);

    const error = await api.setEventCover(EVENT_ID, UPLOAD_ID).catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('upload_missing');
  });
});

describe('invite endpoints', () => {
  const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const TOKEN = 'a'.repeat(43);
  const preview = {
    role: 'guest',
    event: {
      id: EVENT_ID,
      name: "Ayesha & Omar's Wedding",
      cover: null,
      startsAt: '2026-10-03T13:00:00.000Z',
      endsAt: '2026-10-04T18:00:00.000Z',
      venueNames: ['Pearl Continental', 'Nishat Hotel'],
    },
    membership: null,
  };

  function signedIn(accessToken: string): SessionResult {
    return { data: { session: { access_token: accessToken } }, error: null };
  }

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

  function initOf(fetchMock: ReturnType<typeof answersInTurn>, call: number) {
    return fetchMock.mock.calls[call]?.[1] ?? {};
  }

  function headersOf(fetchMock: ReturnType<typeof answersInTurn>, call: number) {
    return (initOf(fetchMock, call).headers ?? {}) as Record<string, string>;
  }

  function errorBody(code: string) {
    return { error: { code, message: 'refused' } };
  }

  it('resolves a signed-out lookup with no Authorization header (D-115)', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fetchMock = answersInTurn([200, preview]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.resolveInvite({ token: TOKEN })).resolves.toEqual(preview);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/invites/resolve');
    expect(initOf(fetchMock, 0).method).toBe('POST');
    expect(headersOf(fetchMock, 0).Authorization).toBeUndefined();
  });

  it('sends the token in the body and never the path, which nginx logs (arch:invite)', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fetchMock = answersInTurn([200, preview]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await api.resolveInvite({ token: TOKEN });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(TOKEN);
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ token: TOKEN });
  });

  it('resolves a signed-in lookup with the access token, so the answer carries the membership', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([
      200,
      { ...preview, membership: { role: 'guest', status: 'pending' } },
    ]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    const answer = await api.resolveInvite({ code: 'AB3K7X' });
    expect(answer.membership).toEqual({ role: 'guest', status: 'pending' });
    expect(headersOf(fetchMock, 0).Authorization).toBe('Bearer token-1');
  });

  it('refreshes once and retries a signed-in lookup that answers 401', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    mockAuth.refreshSession.mockResolvedValue(signedIn('token-2'));
    const fetchMock = answersInTurn([401, errorBody('no_session')], [200, preview]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.resolveInvite({ token: TOKEN })).resolves.toEqual(preview);
    expect(headersOf(fetchMock, 1).Authorization).toBe('Bearer token-2');
  });

  it('never looks an invite up as signed out when a stored session cannot be refreshed offline', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Network request failed', 0),
    });
    const fetchMock = answersInTurn([200, preview]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.resolveInvite({ token: TOKEN })).rejects.toBeInstanceOf(api.ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws not_found for a dead invite', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    globalThis.fetch = answersInTurn([404, errorBody('not_found')]);
    const api = loadApi(BASE_URL);

    const error = await api.resolveInvite({ code: 'AB3K7X' }).catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).code).toBe('not_found');
  });

  it('refuses a preview that carries a cover with no cache key (root invariant 2)', async () => {
    mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const cover = { url: 'https://r2.example.test/get?sig=1' };
    globalThis.fetch = answersInTurn([200, { ...preview, event: { ...preview.event, cover } }]);
    const api = loadApi(BASE_URL);

    await expect(api.resolveInvite({ token: TOKEN })).rejects.toBeInstanceOf(api.ApiError);
  });

  it('joins with the lookup in the body and accepts a 201 and a 200 alike', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const joined = { membership: { role: 'guest', status: 'active' } };
    const fetchMock = answersInTurn([201, joined], [200, joined]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.joinEvent({ token: TOKEN })).resolves.toEqual(joined);
    await expect(api.joinEvent({ token: TOKEN })).resolves.toEqual(joined);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/invites/join');
    expect(initOf(fetchMock, 0).method).toBe('POST');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ token: TOKEN });
  });

  it.each([
    [403, 'blocked'],
    [404, 'not_found'],
    [422, 'event_full'],
  ])('carries a %i %s from a join to the screen', async (status, code) => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([status, errorBody(code)]);
    const api = loadApi(BASE_URL);

    const error = await api.joinEvent({ code: 'AB3K7X' }).catch((e: unknown) => e);
    expect((error as InstanceType<Api['ApiError']>).code).toBe(code);
    expect((error as InstanceType<Api['ApiError']>).status).toBe(status);
  });

  it('refuses a join answer that leaves the caller blocked, which a join never does', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([200, { membership: { role: 'guest', status: 'blocked' } }]);
    const api = loadApi(BASE_URL);

    await expect(api.joinEvent({ token: TOKEN })).rejects.toBeInstanceOf(api.ApiError);
  });

  it('cancels a join request with a bodyless DELETE on the event path', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([200, { membership: null }]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.cancelJoinRequest(EVENT_ID)).resolves.toEqual({ membership: null });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${EVENT_ID}/join-request`,
    );
    expect(initOf(fetchMock, 0).method).toBe('DELETE');
    expect(initOf(fetchMock, 0).body).toBeUndefined();
    expect(headersOf(fetchMock, 0).Authorization).toBe('Bearer token-1');
  });

  it('hands back the active row when a cancel loses the race with an approve', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const approved = { membership: { role: 'guest', status: 'active' } };
    globalThis.fetch = answersInTurn([200, approved]);
    const api = loadApi(BASE_URL);

    await expect(api.cancelJoinRequest(EVENT_ID)).resolves.toEqual(approved);
  });
});

describe('sub-event endpoints', () => {
  const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const SUB_EVENT_ID = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';
  const subEvent = {
    id: SUB_EVENT_ID,
    name: 'Nikkah',
    description: null,
    startsAt: '2026-10-03T13:00:00.000Z',
    endsAt: '2026-10-03T18:00:00.000Z',
    verificationRadiusM: 200,
    venue: {
      id: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b',
      name: 'Pearl Continental',
      lat: 31.5546,
      lng: 74.3572,
    },
  };
  const schedule = { subEvents: [subEvent] };
  const addRequest = {
    requestId: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
    name: 'Walima',
    startsAt: '2026-10-04T13:00:00.000Z',
    endsAt: '2026-10-04T18:00:00.000Z',
    venue: { id: subEvent.venue.id },
    verificationRadiusM: 200,
  };

  function signedIn(accessToken: string): SessionResult {
    return { data: { session: { access_token: accessToken } }, error: null };
  }

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

  function initOf(fetchMock: ReturnType<typeof answersInTurn>, call: number) {
    return fetchMock.mock.calls[call]?.[1] ?? {};
  }

  function errorBody(code: string) {
    return { error: { code, message: 'refused' } };
  }

  async function failure(promise: Promise<unknown>) {
    return (await promise.catch((e: unknown) => e)) as InstanceType<Api['ApiError']>;
  }

  it('GETs the schedule on the event path and returns it parsed', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([200, schedule]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.listSubEvents(EVENT_ID)).resolves.toEqual(schedule);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${EVENT_ID}/sub-events`,
    );
    expect(initOf(fetchMock, 0).method).toBe('GET');
  });

  it('refuses a schedule with no sub-event, which no event has (D-88)', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([200, { subEvents: [] }]);
    const api = loadApi(BASE_URL);

    await expect(api.listSubEvents(EVENT_ID)).rejects.toBeInstanceOf(api.ApiError);
  });

  it('throws not_member for a removed member, so the shell can show the lost state', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([403, errorBody('not_member')]);
    const api = loadApi(BASE_URL);

    const error = await failure(api.listSubEvents(EVENT_ID));
    expect(error.status).toBe(403);
    expect(error.code).toBe('not_member');
  });

  it('POSTs an add with its requestId and accepts a 201 and a 200 alike', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([201, schedule], [200, schedule]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.addSubEvent(EVENT_ID, addRequest)).resolves.toEqual(schedule);
    await expect(api.addSubEvent(EVENT_ID, addRequest)).resolves.toEqual(schedule);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${EVENT_ID}/sub-events`,
    );
    expect(initOf(fetchMock, 0).method).toBe('POST');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual(addRequest);
  });

  it('throws too_many_sub_events for a 16th', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([422, errorBody('too_many_sub_events')]);
    const api = loadApi(BASE_URL);

    expect((await failure(api.addSubEvent(EVENT_ID, addRequest))).code).toBe('too_many_sub_events');
  });

  it('PATCHes only the fields given, on the sub-event path', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([200, schedule]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.updateSubEvent(SUB_EVENT_ID, { name: 'Baraat' })).resolves.toEqual(schedule);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/sub-events/${SUB_EVENT_ID}`,
    );
    expect(initOf(fetchMock, 0).method).toBe('PATCH');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ name: 'Baraat' });
  });

  it('throws wrong_role when a Guest tries to edit, so the app refetches the role (D-118)', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([403, errorBody('wrong_role')]);
    const api = loadApi(BASE_URL);

    const error = await failure(api.updateSubEvent(SUB_EVENT_ID, { name: 'Baraat' }));
    expect(error.status).toBe(403);
    expect(error.code).toBe('wrong_role');
  });

  it('throws event_too_long for a Delay that stretches the event past 14 days', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([422, errorBody('event_too_long')]);
    const api = loadApi(BASE_URL);

    const body = { startsAt: subEvent.startsAt, endsAt: '2026-10-20T18:00:00.000Z' };
    expect((await failure(api.updateSubEvent(SUB_EVENT_ID, body))).code).toBe('event_too_long');
  });

  it('deletes with a bodyless DELETE on the sub-event path', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answersInTurn([200, schedule]);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.deleteSubEvent(SUB_EVENT_ID)).resolves.toEqual(schedule);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/sub-events/${SUB_EVENT_ID}`,
    );
    expect(initOf(fetchMock, 0).method).toBe('DELETE');
    expect(initOf(fetchMock, 0).body).toBeUndefined();
  });

  it('throws last_sub_event for the last one, never reading a schedule out of it', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answersInTurn([409, errorBody('last_sub_event')]);
    const api = loadApi(BASE_URL);

    const error = await failure(api.deleteSubEvent(SUB_EVENT_ID));
    expect(error.status).toBe(409);
    expect(error.code).toBe('last_sub_event');
  });
});

describe('event settings endpoints', () => {
  const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const settings = {
    name: 'Him & Her',
    description: null,
    approvalMode: 'manual',
    cover: null,
    pendingCount: 3,
    pendingPhotographers: ['Sara Ahmed'],
  };

  function signedIn(accessToken: string): SessionResult {
    return { data: { session: { access_token: accessToken } }, error: null };
  }

  function initOf(fetchMock: ReturnType<typeof answers>, call: number) {
    return fetchMock.mock.calls[call]?.[1] ?? {};
  }

  function errorBody(code: string) {
    return { error: { code, message: 'refused' } };
  }

  async function failure(promise: Promise<unknown>) {
    return (await promise.catch((e: unknown) => e)) as InstanceType<Api['ApiError']>;
  }

  it('GETs the settings on the event path and returns them parsed', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const fetchMock = answers(200, { settings });
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.getEventSettings(EVENT_ID)).resolves.toEqual({ settings });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${EVENT_ID}/settings`,
    );
    expect(initOf(fetchMock, 0).method).toBe('GET');
  });

  // EventSettings refuses more pending Photographers than pending requests.
  it('refuses settings that name more Photographers than are pending', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answers(200, { settings: { ...settings, pendingCount: 0 } });
    const api = loadApi(BASE_URL);

    await expect(api.getEventSettings(EVENT_ID)).rejects.toBeInstanceOf(api.ApiError);
  });

  it('throws wrong_role for a Guest or a Photographer, so the app refetches the role', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answers(403, errorBody('wrong_role'));
    const api = loadApi(BASE_URL);

    const error = await failure(api.getEventSettings(EVENT_ID));
    expect(error.status).toBe(403);
    expect(error.code).toBe('wrong_role');
  });

  it('PATCHes only the fields given and returns the settings and how many were let in', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    const answer = {
      settings: { ...settings, approvalMode: 'auto', pendingCount: 0, pendingPhotographers: [] },
      admitted: 3,
    };
    const fetchMock = answers(200, answer);
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);

    await expect(api.updateEventSettings(EVENT_ID, { approvalMode: 'auto' })).resolves.toEqual(
      answer,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${EVENT_ID}/settings`,
    );
    expect(initOf(fetchMock, 0).method).toBe('PATCH');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ approvalMode: 'auto' });
  });

  it('throws not_found for a deleted event, never reading settings out of it', async () => {
    mockAuth.getSession.mockResolvedValue(signedIn('token-1'));
    globalThis.fetch = answers(404, errorBody('not_found'));
    const api = loadApi(BASE_URL);

    const error = await failure(api.updateEventSettings(EVENT_ID, { name: 'Ayesha' }));
    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
  });
});

describe('My Media publish status', () => {
  const eventId = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const mediaId = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
  it('POSTs only the requested ids and validates the status envelope', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
    const fetchMock = answers(200, { statuses: [{ mediaId, status: 'published' }] });
    globalThis.fetch = fetchMock;
    const api = loadApi(BASE_URL);
    await expect(api.getMediaStatus(eventId, { mediaIds: [mediaId] })).resolves.toEqual({
      statuses: [{ mediaId, status: 'published' }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${eventId}/media/status`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      mediaIds: [mediaId],
    });
  });
  it('refuses a malformed status response', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
    globalThis.fetch = answers(200, { statuses: [{ mediaId, status: 'ready' }] });
    const api = loadApi(BASE_URL);
    await expect(api.getMediaStatus(eventId, { mediaIds: [mediaId] })).rejects.toBeInstanceOf(
      api.ApiError,
    );
  });
});

describe('upload pre-flight and completion (D-146)', () => {
  const eventId = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
  const mediaId = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
  const subEventId = '11111111-1111-4111-8111-111111111111';
  const body = { contentHash: 'a'.repeat(64), subEventId, capturedAt: '2026-10-04T10:15:30.000Z' };
  const upload = {
    mediaId,
    photoUploadUrl: 'https://account.r2.cloudflarestorage.com/photo?X-Amz-Signature=1',
    thumbnailUploadUrl: 'https://account.r2.cloudflarestorage.com/thumb?X-Amz-Signature=2',
  };
  function signInAs(id: string, token = 'token') {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: token, user: { id } } } as SessionResult['data'],
      error: null,
    });
  }

  it.each([201, 200])('POSTs the pre-flight as JSON and accepts %s', async (status) => {
    signInAs('A');
    const fetched = answers(status, upload);
    globalThis.fetch = fetched;
    await expect(loadApi(BASE_URL).preflightUpload('A', eventId, body)).resolves.toEqual(upload);
    expect(fetched.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${eventId}/media/preflight`,
    );
    expect(fetched.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetched.mock.calls[0]?.[1]?.body as string)).toEqual(body);
  });

  it('POSTs completion with no body', async () => {
    signInAs('A');
    const fetched = answers(200, { status: 'completed' });
    globalThis.fetch = fetched;
    await expect(loadApi(BASE_URL).completeUpload('A', mediaId)).resolves.toEqual({
      status: 'completed',
    });
    expect(fetched.mock.calls[0]?.[0]).toBe(`https://api.example.test/media/${mediaId}/complete`);
    expect(fetched.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('refuses to send a queued photo under another account’s session', async () => {
    signInAs('B');
    const fetched = answers(201, upload);
    globalThis.fetch = fetched;
    const api = loadApi(BASE_URL);
    await expect(api.preflightUpload('A', eventId, body)).rejects.toBeInstanceOf(
      api.AccountChangedError,
    );
    await expect(api.completeUpload('A', mediaId)).rejects.toBeInstanceOf(api.AccountChangedError);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('refuses the retry after a 401 when the refreshed session is another account', async () => {
    signInAs('A');
    mockAuth.refreshSession.mockResolvedValue({
      data: { session: { access_token: 'fresh', user: { id: 'B' } } } as SessionResult['data'],
      error: null,
    });
    const fetched = answers(401, { error: { code: 'no_session', message: 'expired' } });
    globalThis.fetch = fetched;
    const api = loadApi(BASE_URL);
    await expect(api.preflightUpload('A', eventId, body)).rejects.toBeInstanceOf(
      api.AccountChangedError,
    );
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('passes on the refusal code for the queue to act on', async () => {
    signInAs('A');
    globalThis.fetch = answers(409, { error: { code: 'album_closed', message: 'closed' } });
    await expect(loadApi(BASE_URL).preflightUpload('A', eventId, body)).rejects.toMatchObject({
      status: 409,
      code: 'album_closed',
    });
  });
});

describe('GET /events/{eventId}/media', () => {
  const eventId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const subEventId = '11111111-1111-4111-8111-111111111111';
  const uploaderId = '22222222-2222-4222-8222-222222222222';
  const mediaId = '33333333-3333-4333-8333-333333333333';

  function signIn() {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
  }

  it('GETs the album with query parameters and returns parsed response', async () => {
    signIn();
    const albumData = {
      media: [
        {
          id: mediaId,
          subEventId,
          capturedAt: new Date().toISOString(),
          uploaderRole: 'guest',
          width: 1200,
          height: 800,
        },
      ],
      sectionCounts: [{ subEventId, count: 1 }],
      nextCursor: 'next-cursor-token',
    };
    const fetched = answers(200, albumData);
    globalThis.fetch = fetched;

    const result = await loadApi(BASE_URL).listAlbum(eventId, {
      subEventId,
      uploaderId,
      cursor: 'cursor-token',
    });

    expect(result).toEqual(albumData);
    const url = fetched.mock.calls[0]?.[0] as string;
    expect(url).toContain(`/events/${eventId}/media`);
    expect(url).toContain(`subEventId=${subEventId}`);
    expect(url).toContain(`uploaderId=${uploaderId}`);
    expect(url).toContain(`cursor=cursor-token`);
  });

  it('throws ApiError with wrong_role on Photographer refusal', async () => {
    signIn();
    globalThis.fetch = answers(403, {
      error: { code: 'wrong_role', message: 'Photographers cannot view the shared album' },
    });

    await expect(loadApi(BASE_URL).listAlbum(eventId)).rejects.toMatchObject({
      status: 403,
      code: 'wrong_role',
    });
  });

  it('throws ApiError with not_member on non-member access', async () => {
    signIn();
    globalThis.fetch = answers(403, {
      error: { code: 'not_member', message: 'Not an active member' },
    });

    await expect(loadApi(BASE_URL).listAlbum(eventId)).rejects.toMatchObject({
      status: 403,
      code: 'not_member',
    });
  });
});

describe('POST /events/{eventId}/media/images', () => {
  const eventId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const mediaId = '33333333-3333-4333-8333-333333333333';

  function signIn() {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
  }

  it('POSTs image request and returns presigned URLs and cache keys', async () => {
    signIn();
    const imagesData = {
      images: {
        [mediaId]: {
          url: 'https://r2.example.com/signed.webp',
          cacheKey: `${mediaId}/public_thumb_v1.webp#v1`,
        },
      },
    };
    const fetched = answers(200, imagesData);
    globalThis.fetch = fetched;

    const result = await loadApi(BASE_URL).getMediaImages(eventId, {
      mediaIds: [mediaId],
      size: 'thumbnail',
    });

    expect(result).toEqual(imagesData);
    expect(fetched.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${eventId}/media/images`,
    );
    expect(JSON.parse(fetched.mock.calls[0]?.[1]?.body as string)).toEqual({
      mediaIds: [mediaId],
      size: 'thumbnail',
    });
  });

  it('throws ApiError on 400 invalid_request', async () => {
    signIn();
    globalThis.fetch = answers(400, {
      error: { code: 'invalid_request', message: 'Too many ids' },
    });

    await expect(
      loadApi(BASE_URL).getMediaImages(eventId, { mediaIds: [mediaId], size: 'thumbnail' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });
});

describe('GET /events/{eventId}/media/uploaders', () => {
  const eventId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const userId = '22222222-2222-4222-8222-222222222222';

  function signIn() {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    });
  }

  it('GETs uploaders list', async () => {
    signIn();
    const uploadersData = {
      uploaders: [
        {
          userId,
          fullName: 'Sana Iqbal',
          role: 'guest',
          photoCount: 88,
          avatar: null,
        },
      ],
    };
    const fetched = answers(200, uploadersData);
    globalThis.fetch = fetched;

    const result = await loadApi(BASE_URL).listUploaders(eventId);
    expect(result).toEqual(uploadersData);
    expect(fetched.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${eventId}/media/uploaders`,
    );
  });

  it('throws ApiError on wrong_role', async () => {
    signIn();
    globalThis.fetch = answers(403, {
      error: { code: 'wrong_role', message: 'Photographer cannot list uploaders' },
    });

    await expect(loadApi(BASE_URL).listUploaders(eventId)).rejects.toMatchObject({
      status: 403,
      code: 'wrong_role',
    });
  });
});
