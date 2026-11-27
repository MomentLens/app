import { describe, expect, it } from '@jest/globals';
import type { AlbumMediaItem, ListAlbumResponse } from '@momentlens/shared-types';
import type { InfiniteData } from '@tanstack/react-query';

import {
  MANUAL_BLUR_NOTICE,
  PRIVACY_BLUR_NOTICE,
  blurNotice,
  maxOffset,
  nextAnchor,
  pagerWindow,
  removeFromAlbum,
  shouldLoadMore,
  viewerActions,
  zoomAbout,
} from '@/features/photo-viewer/model';

const photo = (id: string, subEventId = 'sub-1'): AlbumMediaItem => ({
  id,
  subEventId,
  capturedAt: '2026-10-03T16:14:00Z',
  uploaderUserId: '11111111-1111-4111-8111-111111111111',
  uploaderName: 'Ayesha Khan',
  uploaderRole: 'guest',
  width: 3000,
  height: 4000,
  variantVersion: 1,
});

describe('nextAnchor', () => {
  it('stays on the photo while it is still listed', () => {
    expect(nextAnchor(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], 'b')).toBe('b');
  });

  it('moves to the next photo when the one shown leaves', () => {
    expect(nextAnchor(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
  });

  it('skips a following photo that left at the same time', () => {
    expect(nextAnchor(['a', 'b', 'c', 'd'], ['a', 'd'], 'b')).toBe('d');
  });

  it('moves back to the previous photo when the last one leaves', () => {
    expect(nextAnchor(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
  });

  it('gives null when no photo is left, so the viewer closes', () => {
    expect(nextAnchor(['a'], [], 'a')).toBeNull();
  });

  it('gives null for a photo the list never held', () => {
    expect(nextAnchor([], ['a', 'b'], 'z')).toBeNull();
  });
});

describe('pagerWindow', () => {
  it('mounts the photo shown and one either side', () => {
    expect(pagerWindow(['a', 'b', 'c', 'd'], 2)).toEqual([
      { item: 'b', index: 1 },
      { item: 'c', index: 2 },
      { item: 'd', index: 3 },
    ]);
  });

  it('mounts two at either end of the list', () => {
    expect(pagerWindow(['a', 'b', 'c'], 0).map((slot) => slot.item)).toEqual(['a', 'b']);
    expect(pagerWindow(['a', 'b', 'c'], 2).map((slot) => slot.item)).toEqual(['b', 'c']);
  });
});

describe('shouldLoadMore', () => {
  it('asks for the next page within 5 photos of the last loaded one', () => {
    expect(shouldLoadMore(44, 50)).toBe(false);
    expect(shouldLoadMore(45, 50)).toBe(true);
    expect(shouldLoadMore(49, 50)).toBe(true);
  });

  it('never asks before the photo is found', () => {
    expect(shouldLoadMore(-1, 3)).toBe(false);
  });
});

describe('viewerActions', () => {
  it('gives a Guest Blur and Flag on somebody else’s photo, and no Delete', () => {
    expect(viewerActions('guest', false)).toEqual({ blur: true, flag: true, delete: false });
  });

  it('gives a Guest Delete in place of Flag on their own photo', () => {
    expect(viewerActions('guest', true)).toEqual({ blur: true, flag: false, delete: true });
  });

  it('gives the Admin Blur and Delete on every photo, and never Flag', () => {
    expect(viewerActions('admin', false)).toEqual({ blur: true, flag: false, delete: true });
    expect(viewerActions('admin', true)).toEqual({ blur: true, flag: false, delete: true });
  });

  it('gives a Photographer nothing', () => {
    expect(viewerActions('photographer', true)).toEqual({
      blur: false,
      flag: false,
      delete: false,
    });
  });
});

describe('blurNotice', () => {
  it('hides the icon when nothing in this viewer’s file is blurred', () => {
    expect(blurNotice({ hasPrivacyBlur: false, hasManualBlur: false })).toBeNull();
    expect(blurNotice(undefined)).toBeNull();
  });

  it('names a Do Not Publish blur, a blur region, or both', () => {
    expect(blurNotice({ hasPrivacyBlur: true, hasManualBlur: false })).toEqual([
      PRIVACY_BLUR_NOTICE,
    ]);
    expect(blurNotice({ hasPrivacyBlur: false, hasManualBlur: true })).toEqual([
      MANUAL_BLUR_NOTICE,
    ]);
    expect(blurNotice({ hasPrivacyBlur: true, hasManualBlur: true })).toEqual([
      PRIVACY_BLUR_NOTICE,
      MANUAL_BLUR_NOTICE,
    ]);
  });
});

describe('removeFromAlbum', () => {
  const album: InfiniteData<ListAlbumResponse> = {
    pageParams: [undefined, 'cursor-1'],
    pages: [
      {
        media: [photo('a'), photo('b')],
        nextCursor: 'cursor-1',
        sectionCounts: [
          { subEventId: 'sub-1', count: 3 },
          { subEventId: 'sub-2', count: 1 },
        ],
      },
      { media: [photo('c'), photo('d', 'sub-2')], sectionCounts: null, nextCursor: null },
    ],
  };

  it('takes the photo out of a later page and lowers its section’s count on the first', () => {
    const next = removeFromAlbum(album, 'c') as InfiniteData<ListAlbumResponse>;
    expect(next.pages.flatMap((page) => page.media.map((item) => item.id))).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(next.pages[0]!.sectionCounts).toEqual([
      { subEventId: 'sub-1', count: 2 },
      { subEventId: 'sub-2', count: 1 },
    ]);
  });

  it('drops a section whose last photo goes', () => {
    const next = removeFromAlbum(album, 'd') as InfiniteData<ListAlbumResponse>;
    expect(next.pages[0]!.sectionCounts).toEqual([{ subEventId: 'sub-1', count: 3 }]);
  });

  it('leaves the data alone when the photo is not in it', () => {
    expect(removeFromAlbum(album, 'z')).toBe(album);
  });

  it('works on the More sheet’s single page', () => {
    const page: ListAlbumResponse = {
      media: [photo('a')],
      nextCursor: null,
      sectionCounts: [{ subEventId: 'sub-1', count: 1 }],
    };
    expect(removeFromAlbum(page, 'a')).toEqual({ media: [], nextCursor: null, sectionCounts: [] });
  });
});

describe('zoom', () => {
  it('lets a photo move only as far as it overhangs the screen', () => {
    expect(maxOffset(400, 400, 1)).toBe(0);
    expect(maxOffset(400, 400, 2)).toBe(200);
    expect(maxOffset(300, 800, 2)).toBe(0);
  });

  it('keeps the pinched point under the fingers', () => {
    // A point 100pt right of centre, unmoved, at 1x sits at 100. At 2x, offset -100 keeps it there.
    expect(zoomAbout(100, 0, 1, 2)).toBe(-100);
    expect(100 * 2 + zoomAbout(100, 0, 1, 2)).toBe(100);
  });
});
