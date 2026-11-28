import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  FlaggedPhoto,
  ListAlbumResponse,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsResponse,
  ReviewBlurRegion,
} from '@momentlens/shared-types';
import { onlineManager, type InfiniteData } from '@tanstack/react-query';

import { blurRegionsQueryKey } from '@/features/blur-regions/use-blur-regions';
import { eventQueryKey } from '@/features/event-shell/use-event';
import {
  flaggedPhotosQueryKey,
  reviewBlurRegionsQueryKey,
  reviewQueueKey,
} from '@/features/review-queue/model';
import {
  deleteFlaggedPhoto,
  flaggedPhotosQueryOptions,
  keepFlags,
  keepRegion,
  removeRegion,
  reviewBlurRegionsQueryOptions,
} from '@/features/review-queue/use-review-queue';
import {
  ApiError,
  deleteMedia,
  keepBlurRegion,
  keepPhotoFlags,
  listFlaggedPhotos,
  listReviewBlurRegions,
  removeBlurRegion,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => undefined, remove: () => true }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  listFlaggedPhotos: jest.fn(),
  keepPhotoFlags: jest.fn(),
  listReviewBlurRegions: jest.fn(),
  keepBlurRegion: jest.fn(),
  deleteMedia: jest.fn(),
  removeBlurRegion: jest.fn(),
}));

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const SUB = '1c6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const UPLOADER = '2d6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const R1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const R2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const listFlags = jest.mocked(listFlaggedPhotos);
const listRegions = jest.mocked(listReviewBlurRegions);
const keepFlagsCall = jest.mocked(keepPhotoFlags);
const keepRegionCall = jest.mocked(keepBlurRegion);
const deleteCall = jest.mocked(deleteMedia);
const removeCall = jest.mocked(removeBlurRegion);

function item(id: string) {
  return {
    id,
    subEventId: SUB,
    uploaderUserId: UPLOADER,
    uploaderName: 'Hamza Siddiqui',
    uploaderRole: 'guest' as const,
    capturedAt: '2026-11-20T10:00:00.000Z',
    width: 4000,
    height: 3000,
    variantVersion: 2,
  };
}

function photo(id: string): FlaggedPhoto {
  return {
    media: item(id),
    subEventName: 'Nikah',
    flagCount: 1,
    latestFlaggedAt: '2026-11-20T11:58:00.000Z',
  };
}

function region(id: string, mediaId: string): ReviewBlurRegion {
  return {
    region: {
      id,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      drawnBy: { userId: UPLOADER, fullName: 'Ayesha Khan' },
      createdAt: '2026-11-20T10:22:00.000Z',
    },
    media: { id: mediaId, width: 4000, height: 3000, variantVersion: 3 },
  };
}

const flagsKey = flaggedPhotosQueryKey(EVENT);
const regionsKey = reviewBlurRegionsQueryKey(EVENT);
const albumKey = ['album', EVENT, 'all'];

function seed() {
  queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
  queryClient.setQueryData<InfiniteData<ListFlaggedPhotosResponse>>(flagsKey, {
    pageParams: [undefined],
    pages: [{ photos: [photo(A), photo(B)], openCount: 2, nextCursor: null }],
  });
  queryClient.setQueryData<InfiniteData<ListReviewBlurRegionsResponse>>(regionsKey, {
    pageParams: [undefined],
    pages: [{ regions: [region(R1, A), region(R2, B)], openCount: 2, nextCursor: null }],
  });
  queryClient.setQueryData<InfiniteData<ListAlbumResponse>>(albumKey, {
    pageParams: [undefined],
    pages: [{ media: [item(A), item(B)], sectionCounts: null, nextCursor: null }],
  });
}

function flagIds() {
  return (
    queryClient
      .getQueryData<InfiniteData<ListFlaggedPhotosResponse>>(flagsKey)
      ?.pages.flatMap((page) => page.photos.map((entry) => entry.media.id)) ?? []
  );
}

function regionIds() {
  return (
    queryClient
      .getQueryData<InfiniteData<ListReviewBlurRegionsResponse>>(regionsKey)
      ?.pages.flatMap((page) => page.regions.map((entry) => entry.region.id)) ?? []
  );
}

function albumIds() {
  return (
    queryClient
      .getQueryData<InfiniteData<ListAlbumResponse>>(albumKey)
      ?.pages.flatMap((page) => page.media.map((entry) => entry.id)) ?? []
  );
}

const invalidated = (key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated === true;

beforeEach(seed);

afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
  jest.resetAllMocks();
});

describe('the lists', () => {
  it('passes the cursor through and stops when the API says the last page', async () => {
    listFlags.mockResolvedValue({ photos: [], openCount: 0, nextCursor: 'opaque+2' });
    const options = flaggedPhotosQueryOptions(EVENT);
    queryClient.removeQueries({ queryKey: flagsKey });
    await queryClient.fetchInfiniteQuery(options);
    expect(listFlags).toHaveBeenCalledWith(EVENT, { cursor: undefined }, expect.anything());
    expect(options.getNextPageParam({ photos: [], openCount: 0, nextCursor: 'opaque+2' })).toBe(
      'opaque+2',
    );
    expect(
      reviewBlurRegionsQueryOptions(EVENT).getNextPageParam({
        regions: [],
        openCount: 0,
        nextCursor: null,
      }),
    ).toBeUndefined();
  });

  it.each([403, 404])(
    'rechecks the event on a %s list refusal and does not retry',
    async (status) => {
      listRegions.mockRejectedValue(new ApiError('refused', status));
      queryClient.removeQueries({ queryKey: regionsKey });
      await expect(
        queryClient.fetchInfiniteQuery(reviewBlurRegionsQueryOptions(EVENT)),
      ).rejects.toThrow();
      expect(listRegions).toHaveBeenCalledTimes(1);
      expect(invalidated(eventQueryKey(EVENT))).toBe(true);
    },
  );

  it('keeps both lists under one prefix that Realtime invalidates', () => {
    expect(flagsKey.slice(0, 2)).toEqual([...reviewQueueKey(EVENT)]);
    expect(regionsKey.slice(0, 2)).toEqual([...reviewQueueKey(EVENT)]);
  });
});

describe('offline', () => {
  it('never calls the API and never queues an action', async () => {
    onlineManager.setOnline(false);
    await expect(keepFlags(EVENT, A)).resolves.toBe('offline');
    await expect(deleteFlaggedPhoto(EVENT, A)).resolves.toBe('offline');
    await expect(keepRegion(EVENT, R1)).resolves.toBe('offline');
    await expect(removeRegion(EVENT, R1, A)).resolves.toBe('offline');
    expect(keepFlagsCall).not.toHaveBeenCalled();
    expect(deleteCall).not.toHaveBeenCalled();
    expect(keepRegionCall).not.toHaveBeenCalled();
    expect(removeCall).not.toHaveBeenCalled();
    expect(flagIds()).toEqual([A, B]);
    expect(regionIds()).toEqual([R1, R2]);
  });
});

describe('Keep on a flagged photo', () => {
  it('drops the photo and lowers the count once the API answers', async () => {
    keepFlagsCall.mockResolvedValue({ mediaId: A, keptCount: 2 });
    await expect(keepFlags(EVENT, A)).resolves.toBe('done');
    expect(keepFlagsCall).toHaveBeenCalledWith(A);
    expect(flagIds()).toEqual([B]);
    expect(
      queryClient.getQueryData<InfiniteData<ListFlaggedPhotosResponse>>(flagsKey)?.pages[0]
        ?.openCount,
    ).toBe(1);
  });

  it('drops the photo and refetches on a 404, because it is gone', async () => {
    keepFlagsCall.mockRejectedValue(new ApiError('gone', 404, 'not_found'));
    await expect(keepFlags(EVENT, A)).resolves.toBe('gone');
    expect(flagIds()).toEqual([B]);
    expect(invalidated(flagsKey)).toBe(true);
    expect(invalidated(eventQueryKey(EVENT))).toBe(true);
  });

  it('leaves the photo in place and rechecks the event on a 403', async () => {
    keepFlagsCall.mockRejectedValue(new ApiError('no', 403, 'wrong_role'));
    await expect(keepFlags(EVENT, A)).resolves.toBe('refused');
    expect(flagIds()).toEqual([A, B]);
    expect(invalidated(eventQueryKey(EVENT))).toBe(true);
  });

  it('leaves the photo in place on a network failure', async () => {
    keepFlagsCall.mockRejectedValue(new ApiError('Network request failed'));
    await expect(keepFlags(EVENT, A)).resolves.toBe('failed');
    expect(flagIds()).toEqual([A, B]);
  });
});

describe('Delete on a flagged photo', () => {
  it('drops the photo from the queue, its regions and Home’s album', async () => {
    deleteCall.mockResolvedValue({ mediaId: A, deletedAt: '2026-11-20T12:00:00.000Z' });
    await expect(deleteFlaggedPhoto(EVENT, A)).resolves.toBe('done');
    expect(deleteCall).toHaveBeenCalledWith(A);
    expect(flagIds()).toEqual([B]);
    expect(regionIds()).toEqual([R2]);
    expect(albumIds()).toEqual([B]);
    expect(invalidated(albumKey)).toBe(true);
  });

  it('counts a 404 as done, since someone already deleted it', async () => {
    deleteCall.mockRejectedValue(new ApiError('gone', 404, 'not_found'));
    await expect(deleteFlaggedPhoto(EVENT, A)).resolves.toBe('done');
    expect(flagIds()).toEqual([B]);
    expect(albumIds()).toEqual([B]);
  });

  it('keeps everything on a 403', async () => {
    deleteCall.mockRejectedValue(new ApiError('no', 403, 'not_member'));
    await expect(deleteFlaggedPhoto(EVENT, A)).resolves.toBe('refused');
    expect(flagIds()).toEqual([A, B]);
    expect(albumIds()).toEqual([A, B]);
  });
});

describe('Keep and Remove on a blur region', () => {
  it('Keep drops the region and leaves the photo alone', async () => {
    keepRegionCall.mockResolvedValue({ regionId: R1, state: 'kept' });
    await expect(keepRegion(EVENT, R1)).resolves.toBe('done');
    expect(keepRegionCall).toHaveBeenCalledWith(R1);
    expect(regionIds()).toEqual([R2]);
    expect(albumIds()).toEqual([A, B]);
  });

  it('Keep drops the region and refetches on a 404', async () => {
    keepRegionCall.mockRejectedValue(new ApiError('gone', 404, 'not_found'));
    await expect(keepRegion(EVENT, R1)).resolves.toBe('gone');
    expect(regionIds()).toEqual([R2]);
    expect(invalidated(regionsKey)).toBe(true);
  });

  it('Remove drops the region and stores the photo’s new region list', async () => {
    removeCall.mockResolvedValue({ regions: [] });
    await expect(removeRegion(EVENT, R1, A)).resolves.toBe('done');
    expect(removeCall).toHaveBeenCalledWith(R1);
    expect(regionIds()).toEqual([R2]);
    expect(queryClient.getQueryData(blurRegionsQueryKey(A))).toEqual({ regions: [] });
  });

  it('Remove counts a 404 as done', async () => {
    queryClient.setQueryData(blurRegionsQueryKey(A), { regions: [region(R1, A).region] });
    removeCall.mockRejectedValue(new ApiError('gone', 404, 'not_found'));
    await expect(removeRegion(EVENT, R1, A)).resolves.toBe('done');
    expect(regionIds()).toEqual([R2]);
    expect(invalidated(blurRegionsQueryKey(A))).toBe(true);
  });

  it('Remove keeps the region on a 403', async () => {
    removeCall.mockRejectedValue(new ApiError('no', 403, 'wrong_role'));
    await expect(removeRegion(EVENT, R1, A)).resolves.toBe('refused');
    expect(regionIds()).toEqual([R1, R2]);
  });
});
