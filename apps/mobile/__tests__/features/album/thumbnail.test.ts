import { describe, expect, it, jest } from '@jest/globals';
import type { MediaImage } from '@momentlens/shared-types';

import { thumbnailBatches } from '@/features/album/use-album-images';
import { presignedSource } from '@/lib/images';

// The hook's module imports the API client, which needs the native session store.
jest.mock('@/lib/api', () => ({ getMediaImages: jest.fn() }));

describe('Album thumbnail loading and cache keys (D-60, D-86, D-148)', () => {
  it('presignedSource uses the server-returned cacheKey containing variant_version', () => {
    const thumb: MediaImage = {
      url: 'https://r2.example.test/events/e1/media/public/m1_thumb.webp?sig=xyz',
      cacheKey: 'events/e1/media/public/m1_thumb.webp#v2',
    };

    const source = presignedSource(thumb);
    expect(source.uri).toBe(thumb.url);
    expect(source.cacheKey).toBe('events/e1/media/public/m1_thumb.webp#v2');
  });

  it('batches the loaded photos into requests of at most 50', () => {
    const media = Array.from({ length: 125 }, (_, i) => ({
      id: `media-${i + 1}`,
      variantVersion: 1,
    }));
    const batches = thumbnailBatches(media);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 25]);
    expect(batches.flat()).toEqual(media);
  });

  it('handles no photos without a batch', () => {
    expect(thumbnailBatches([])).toEqual([]);
  });
});
