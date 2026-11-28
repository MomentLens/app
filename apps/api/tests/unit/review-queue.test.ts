import { randomUUID } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { ApiError } from '../../src/middleware/errors';
import {
  createReviewQueueStore,
  decodeFlaggedPhotosCursor,
  decodeReviewBlurRegionsCursor,
  encodeFlaggedPhotosCursor,
  encodeReviewBlurRegionsCursor,
} from '../../src/services/review-queue';
import { fakeSql } from '../support/fake-sql';

describe('review queue cursors', () => {
  const eventId = randomUUID();
  const mediaId = randomUUID();
  const regionId = randomUUID();
  const pgTimestamp = '2026-12-10T14:00:00.123456+00:00';

  it('round-trips a flagged-photos cursor with Postgres microseconds', () => {
    const token = encodeFlaggedPhotosCursor({
      kind: 'flags',
      eventId,
      latestFlaggedAt: pgTimestamp,
      mediaId,
    });
    expect(decodeFlaggedPhotosCursor(token)).toEqual({
      kind: 'flags',
      eventId,
      latestFlaggedAt: pgTimestamp,
      mediaId,
    });
  });

  it('round-trips a blur-regions cursor with Postgres microseconds', () => {
    const token = encodeReviewBlurRegionsCursor({
      kind: 'blur-regions',
      eventId,
      createdAt: pgTimestamp,
      regionId,
    });
    expect(decodeReviewBlurRegionsCursor(token)).toEqual({
      kind: 'blur-regions',
      eventId,
      createdAt: pgTimestamp,
      regionId,
    });
  });

  it('rejects non-canonical base64url, malformed JSON, wrong kind, and missing or extra fields', () => {
    const flagsToken = encodeFlaggedPhotosCursor({
      kind: 'flags',
      eventId,
      latestFlaggedAt: pgTimestamp,
      mediaId,
    });
    const regionsToken = encodeReviewBlurRegionsCursor({
      kind: 'blur-regions',
      eventId,
      createdAt: pgTimestamp,
      regionId,
    });

    // Cross-endpoint cursor replay must fail with 400 invalid_request.
    expect(() => decodeReviewBlurRegionsCursor(flagsToken)).toThrow(ApiError);
    expect(() => decodeFlaggedPhotosCursor(regionsToken)).toThrow(ApiError);

    const badTokens = [
      'not-json-at-all',
      `${flagsToken}=`,
      Buffer.from('{"kind":"flags"}').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          kind: 'flags',
          eventId,
          latestFlaggedAt: pgTimestamp,
          mediaId,
          extra: true,
        }),
      ).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          kind: 'flags',
          eventId: 'not-a-uuid',
          latestFlaggedAt: pgTimestamp,
          mediaId,
        }),
      ).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          kind: 'blur-regions',
          eventId,
          createdAt: 'not-a-timestamp',
          regionId,
        }),
      ).toString('base64url'),
    ];

    for (const bad of badTokens) {
      expect(() => decodeFlaggedPhotosCursor(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_request', status: 400 }),
      );
      expect(() => decodeReviewBlurRegionsCursor(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_request', status: 400 }),
      );
    }
  });
});

describe('createReviewQueueStore RPC calls', () => {
  it('calls keep_photo_flags with named parameters and enforces a single row', async () => {
    const mediaId = randomUUID();
    const userId = randomUUID();
    const calls: { name: string; params: Record<string, unknown> }[] = [];

    const store = createReviewQueueStore(
      fakeSql((name, params) => {
        calls.push({ name, params });
        return Promise.resolve({ data: [{ outcome: 'kept', kept_count: 3 }], error: null });
      }),
    );

    await expect(store.keepPhotoFlags(mediaId, userId)).resolves.toEqual({
      outcome: 'kept',
      keptCount: 3,
    });
    expect(calls).toEqual([
      { name: 'keep_photo_flags', params: { p_media_id: mediaId, p_user_id: userId } },
    ]);

    const empty = createReviewQueueStore(fakeSql(() => Promise.resolve({ data: [], error: null })));
    await expect(empty.keepPhotoFlags(mediaId, userId)).rejects.toThrow(
      'keep_photo_flags returned 0 rows, expected 1',
    );
  });

  it('calls keep_blur_region with named parameters and enforces a single row', async () => {
    const regionId = randomUUID();
    const userId = randomUUID();
    const calls: { name: string; params: Record<string, unknown> }[] = [];

    const store = createReviewQueueStore(
      fakeSql((name, params) => {
        calls.push({ name, params });
        return Promise.resolve({ data: [{ outcome: 'kept' }], error: null });
      }),
    );

    await expect(store.keepBlurRegion(regionId, userId)).resolves.toEqual({ outcome: 'kept' });
    expect(calls).toEqual([
      { name: 'keep_blur_region', params: { p_region_id: regionId, p_user_id: userId } },
    ]);

    const extra = createReviewQueueStore(
      fakeSql(() =>
        Promise.resolve({ data: [{ outcome: 'kept' }, { outcome: 'kept' }], error: null }),
      ),
    );
    await expect(extra.keepBlurRegion(regionId, userId)).rejects.toThrow(
      'keep_blur_region returned 2 rows, expected 1',
    );
  });
});
