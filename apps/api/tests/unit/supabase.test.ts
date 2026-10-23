import { afterEach, expect, it, jest } from '@jest/globals';
import { createServerClient } from '../../src/db/supabase';
import { createTokenVerifier } from '../../src/middleware/auth';

afterEach(() => {
  jest.restoreAllMocks();
});
const client = () => createServerClient('https://example.test', 'test-key');
function stalled() {
  const deadline = new AbortController();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const request = jest.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted)
          reject(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled'));
        else
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error('Request cancelled'),
              ),
            { once: true },
          );
      }),
  );
  return { deadline, timeout, request };
}
it('bounds a stalled database call and does not retry its timeout', async () => {
  const { deadline, timeout, request } = stalled();
  const pending = Promise.resolve(client().from('event').select('id'));
  await new Promise((resolve) => setImmediate(resolve));
  deadline.abort(new DOMException('Timed out', 'TimeoutError'));
  const result = await pending;
  expect(result.error).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(timeout).toHaveBeenCalledWith(3000);
});
it('preserves caller cancellation', async () => {
  const { request } = stalled();
  const caller = new AbortController();
  const pending = Promise.resolve(client().from('event').select('id').abortSignal(caller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  expect((await pending).error).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(['HS256', 'ES256'])(
  'reports a %s Auth timeout as an unavailable check rather than an invalid session',
  async (alg) => {
    const { deadline } = stalled();
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg, typ: 'JWT', kid: 'audit-timeout-key' })}.${encode({ sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${encode('signature')}`;
    const pending = createTokenVerifier(client())(token);
    // Attach the rejection handler before triggering the abort.
    const assertion = expect(pending).rejects.toThrow('Could not check the access token');
    await new Promise((resolve) => setImmediate(resolve));
    deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    await assertion;
  },
);
