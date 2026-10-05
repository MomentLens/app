import { describe, expect, it, jest } from '@jest/globals';

import { backoffDelay, transitionFor, type Transition } from '@/features/upload-queue/transitions';
import { AccountChangedError, ApiError } from '@/lib/api';

jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

const answer = (status?: number, code?: ConstructorParameters<typeof ApiError>[2]) =>
  new ApiError('test', status, code);

describe('arch §4: what each answer does to a queued photo', () => {
  it.each<[string, ApiError, Transition]>([
    ['no answer', new ApiError('offline'), { type: 'retry' }],
    ['a timeout', new ApiError('slow', undefined, undefined, true), { type: 'retry' }],
    ['500', answer(500, 'internal_error'), { type: 'retry' }],
    ['502 with no body', answer(502), { type: 'retry' }],
    ['a 200 that did not parse', answer(200), { type: 'retry' }],
    ['408', answer(408), { type: 'retry' }],
    ['429', answer(429), { type: 'retry' }],
    ['401', answer(401, 'no_session'), { type: 'session' }],
    ['400', answer(400, 'invalid_request'), { type: 'stop', reason: 'invalid_request' }],
    ['409 duplicate', answer(409, 'duplicate'), { type: 'drop' }],
    ['409 album_closed', answer(409, 'album_closed'), { type: 'wait', state: 'waiting_album' }],
    ['409 unverified', answer(409, 'unverified'), { type: 'wait', state: 'waiting_verification' }],
    ['422 event_full', answer(422, 'event_full'), { type: 'stop', reason: 'event_full' }],
    [
      '422 too_many_unfinished',
      answer(422, 'too_many_unfinished'),
      { type: 'stop', reason: 'too_many_unfinished' },
    ],
    [
      '409 sub_event_missing',
      answer(409, 'sub_event_missing'),
      { type: 'stop', reason: 'sub_event_missing' },
    ],
    ['403 not_member', answer(403, 'not_member'), { type: 'stop', reason: 'not_member' }],
    ['403 with no code', answer(403), { type: 'stop', reason: 'not_member' }],
    ['404 not_found', answer(404, 'not_found'), { type: 'stop', reason: 'not_found' }],
    [
      '409 with a code pre-flight never sends',
      answer(409, 'upload_missing'),
      { type: 'stop', reason: 'invalid_request' },
    ],
    ['an unknown 4xx', answer(418), { type: 'stop', reason: 'invalid_request' }],
  ])('pre-flight %s', (_name, error, expected) => {
    expect(transitionFor('preflight', error)).toEqual(expected);
  });

  it.each<[string, ApiError, Transition]>([
    ['no answer', new ApiError('offline'), { type: 'retry' }],
    ['503', answer(503), { type: 'retry' }],
    ['401', answer(401, 'no_session'), { type: 'session' }],
    ['400', answer(400, 'invalid_request'), { type: 'stop', reason: 'invalid_request' }],
    ['403 not_uploader', answer(403, 'not_uploader'), { type: 'stop', reason: 'not_uploader' }],
    ['403 not_member', answer(403, 'not_member'), { type: 'stop', reason: 'not_member' }],
    ['404 not_found', answer(404, 'not_found'), { type: 'stop', reason: 'not_found' }],
    ['409 upload_missing', answer(409, 'upload_missing'), { type: 'resend' }],
    ['409 duplicate', answer(409, 'duplicate'), { type: 'drop' }],
    [
      '409 album_closed, which completion never checks',
      answer(409, 'album_closed'),
      { type: 'stop', reason: 'invalid_request' },
    ],
  ])('completion %s', (_name, error, expected) => {
    expect(transitionFor('complete', error)).toEqual(expected);
  });

  it('writes nothing when the request was refused for another account', () => {
    const error = new AccountChangedError();
    expect(transitionFor('preflight', error)).toEqual({ type: 'cancel' });
    expect(transitionFor('complete', error)).toEqual({ type: 'cancel' });
  });

  it('retries an error that is not an API answer', () => {
    expect(transitionFor('preflight', new TypeError('x'))).toEqual({ type: 'retry' });
  });
});

describe('backoff (D-146)', () => {
  it('waits 5 seconds after the first failure, doubling to 5 minutes, with no cap on tries', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(backoffDelay)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
  });
});
