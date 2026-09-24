import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  AuthApiError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
} from '@supabase/supabase-js';

import type * as ResetLinkModule from '@/features/auth/reset-link';

const mockExchange = jest.fn<(code: string) => Promise<{ error: unknown }>>();

jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { exchangeCodeForSession: (code: string) => mockExchange(code) } },
}));

// reset-link.ts keeps one answer per code for the life of the JavaScript load, so each test loads
// its own copy.
function load(): typeof ResetLinkModule {
  let loaded: typeof ResetLinkModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof ResetLinkModule>('@/features/auth/reset-link');
  });
  if (loaded === undefined) {
    throw new Error('reset-link did not load');
  }
  return loaded;
}

beforeEach(() => {
  mockExchange.mockReset();
});

describe('exchangeResult', () => {
  const { exchangeResult } = load();

  it('lets the user choose a password when the exchange succeeded', () => {
    expect(exchangeResult(null)).toBe('ok');
  });

  // D-109: a link opened on a phone that did not ask for it fails, and the screen says so.
  it('sends a missing verifier to the phone that asked', () => {
    expect(exchangeResult(new AuthPKCECodeVerifierMissingError())).toBe('otherPhone');
  });

  it('reports a dropped connection as offline', () => {
    expect(exchangeResult(new AuthRetryableFetchError('Network request failed', 0))).toBe(
      'offline',
    );
  });

  it('treats a used, expired or superseded code as expired', () => {
    expect(
      exchangeResult(
        new AuthApiError(
          'invalid flow state, no valid flow state found',
          404,
          'flow_state_not_found',
        ),
      ),
    ).toBe('expired');
    expect(
      exchangeResult(
        new AuthApiError('invalid flow state, flow state has expired', 422, 'flow_state_expired'),
      ),
    ).toBe('expired');
  });

  it('treats anything else as expired', () => {
    expect(exchangeResult(new Error('something else'))).toBe('expired');
    expect(exchangeResult(undefined)).toBe('expired');
  });
});

describe('exchangeOnce', () => {
  it('exchanges a code once, and a remount gets the same answer', async () => {
    const { exchangeOnce } = load();
    mockExchange.mockResolvedValue({ error: null });

    await expect(exchangeOnce('code-a')).resolves.toBe('ok');
    await expect(exchangeOnce('code-a')).resolves.toBe('ok');
    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  // auth-js deletes the verifier after a failed exchange too. A second exchange would report a
  // missing verifier and send the user to another phone for a link that simply expired.
  it('does not exchange a failed code again, so an expired link never reads as another phone', async () => {
    const { exchangeOnce } = load();
    mockExchange
      .mockResolvedValueOnce({
        error: new AuthApiError(
          'invalid flow state, flow state has expired',
          422,
          'flow_state_expired',
        ),
      })
      .mockResolvedValueOnce({ error: new AuthPKCECodeVerifierMissingError() });

    await expect(exchangeOnce('code-a')).resolves.toBe('expired');
    await expect(exchangeOnce('code-a')).resolves.toBe('expired');
    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  it('shares one exchange between two screens that ask at the same time', async () => {
    const { exchangeOnce } = load();
    let settle: (value: { error: unknown }) => void = () => undefined;
    mockExchange.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    const first = exchangeOnce('code-a');
    const second = exchangeOnce('code-a');
    settle({ error: null });
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  it('exchanges a newer code from a second email', async () => {
    const { exchangeOnce } = load();
    mockExchange
      .mockResolvedValueOnce({ error: new AuthRetryableFetchError('Network request failed', 0) })
      .mockResolvedValueOnce({ error: null });

    await expect(exchangeOnce('code-a')).resolves.toBe('offline');
    await expect(exchangeOnce('code-b')).resolves.toBe('ok');
    expect(mockExchange.mock.calls).toEqual([['code-a'], ['code-b']]);
  });

  it('treats an exchange that throws as expired', async () => {
    const { exchangeOnce } = load();
    mockExchange.mockRejectedValue(new TypeError('boom'));

    await expect(exchangeOnce('code-a')).resolves.toBe('expired');
  });
});
