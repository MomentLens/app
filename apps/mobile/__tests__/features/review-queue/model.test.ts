import { describe, expect, it } from '@jest/globals';
import type {
  FlaggedPhoto,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsResponse,
  ReviewBlurRegion,
} from '@momentlens/shared-types';
import type { InfiniteData } from '@tanstack/react-query';

import {
  canReview,
  flaggedPhotos,
  flagSummary,
  openCount,
  reviewBlurRegions,
  segmentLabel,
  uniqueMedia,
  withoutFlaggedPhoto,
  withoutRegion,
  withoutRegionsOnPhoto,
} from '@/features/review-queue/model';

const SUB = '1c6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const UPLOADER = '2d6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';

function photo(id: string, flagCount = 1): FlaggedPhoto {
  return {
    media: {
      id,
      subEventId: SUB,
      uploaderUserId: UPLOADER,
      uploaderName: 'Hamza Siddiqui',
      uploaderRole: 'guest',
      capturedAt: '2026-11-20T10:00:00.000Z',
      width: 4000,
      height: 3000,
      variantVersion: 2,
    },
    subEventName: 'Nikah',
    flagCount,
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

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function flagPages(pages: FlaggedPhoto[][], count: number) {
  return {
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
    pages: pages.map((photos, i): ListFlaggedPhotosResponse => ({
      photos,
      openCount: count,
      nextCursor: i < pages.length - 1 ? `cursor-${i + 1}` : null,
    })),
  } satisfies InfiniteData<ListFlaggedPhotosResponse>;
}

function regionPages(pages: ReviewBlurRegion[][], count: number) {
  return {
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
    pages: pages.map((regions, i): ListReviewBlurRegionsResponse => ({
      regions,
      openCount: count,
      nextCursor: i < pages.length - 1 ? `cursor-${i + 1}` : null,
    })),
  } satisfies InfiniteData<ListReviewBlurRegionsResponse>;
}

describe('who reviews', () => {
  it('lets only the Admin load the queue', () => {
    expect(canReview('admin')).toBe(true);
    expect(canReview('guest')).toBe(false);
    expect(canReview('photographer')).toBe(false);
    expect(canReview(undefined)).toBe(false);
  });
});

describe('loaded lists', () => {
  it('shows a photo once when a refetch leaves it on two pages, at its newest place', () => {
    const data = flagPages(
      [
        [photo(A, 2), photo(B)],
        [photo(A, 1), photo(C)],
      ],
      3,
    );
    const list = flaggedPhotos(data);
    expect(list.map((item) => item.media.id)).toEqual([A, B, C]);
    expect(list[0]!.flagCount).toBe(2);
  });

  it('shows a region once across pages', () => {
    const data = regionPages([[region(A, C)], [region(A, C), region(B, C)]], 2);
    expect(reviewBlurRegions(data).map((item) => item.region.id)).toEqual([A, B]);
  });

  it('signs each photo once when several regions sit on it', () => {
    const items = [region(A, C), region(B, C)].map((item) => item.media);
    expect(uniqueMedia(items)).toEqual([{ id: C, width: 4000, height: 3000, variantVersion: 3 }]);
  });

  it('reads the open count from the first page, and zero before one loads', () => {
    expect(openCount(flagPages([[photo(A)]], 7))).toBe(7);
    expect(openCount(undefined)).toBe(0);
  });
});

describe('dropping an item', () => {
  it('takes a kept or deleted photo off every page and lowers the count on each', () => {
    const data = flagPages(
      [
        [photo(A), photo(B)],
        [photo(A), photo(C)],
      ],
      3,
    );
    const next = withoutFlaggedPhoto(data, A)!;
    expect(flaggedPhotos(next).map((item) => item.media.id)).toEqual([B, C]);
    expect(next.pages.map((page) => page.openCount)).toEqual([2, 2]);
  });

  it('leaves the data as it was when the photo is not loaded', () => {
    const data = flagPages([[photo(B)]], 1);
    expect(withoutFlaggedPhoto(data, A)).toBe(data);
    expect(withoutFlaggedPhoto(undefined, A)).toBeUndefined();
  });

  it('takes a kept or removed region off, and never counts below zero', () => {
    const data = regionPages([[region(A, C)]], 0);
    const next = withoutRegion(data, A)!;
    expect(reviewBlurRegions(next)).toEqual([]);
    expect(next.pages[0]!.openCount).toBe(0);
  });

  it('takes every region on a deleted photo off and lowers the count by each', () => {
    const data = regionPages([[region(A, C), region(B, C)], [region(C, A)]], 3);
    const next = withoutRegionsOnPhoto(data, C)!;
    expect(reviewBlurRegions(next).map((item) => item.region.id)).toEqual([C]);
    expect(next.pages.map((page) => page.openCount)).toEqual([1, 1]);
  });
});

describe('the card text', () => {
  const now = new Date('2026-11-20T15:00:00.000Z');

  it('counts guests only when more than one flagged it, and names nobody', () => {
    const many = flagSummary(2, '2026-11-20T11:58:00.000Z', now);
    expect(many).toMatch(/^Flagged by 2 guests · /);
    const one = flagSummary(1, '2026-11-20T11:58:00.000Z', now);
    expect(one).toMatch(/^Flagged by a guest · /);
  });

  it('adds the day when the flag was not today', () => {
    const today = flagSummary(1, '2026-11-20T11:58:00.000Z', now);
    const earlier = flagSummary(1, '2026-11-18T11:58:00.000Z', now);
    expect(earlier.split(' · ').length).toBe(today.split(' · ').length + 1);
  });
});

describe('the segment labels', () => {
  it('carries the open count so the other segment shows what waits in it', () => {
    expect(segmentLabel('Flagged', 3)).toBe('Flagged (3)');
    expect(segmentLabel('Blurred areas', 1)).toBe('Blurred areas (1)');
  });

  it('shows no count before the first page loads or when nothing is open', () => {
    expect(segmentLabel('Flagged', 0)).toBe('Flagged');
  });
});
