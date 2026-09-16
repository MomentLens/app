import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type * as ApiModule from '@/lib/api';

type Api = typeof ApiModule;

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
