import { describe, expect, it } from '@jest/globals';
import { MAX_MEDIA_IMAGES_BATCH, type MediaImage } from '@momentlens/shared-types';

import { presignedSource } from '@/lib/images';

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

  it('batches IDs into chunks of at most 50 (MAX_MEDIA_IMAGES_BATCH = 50)', () => {
    const ids = Array.from({ length: 125 }, (_, i) => `media-${i + 1}`);

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += MAX_MEDIA_IMAGES_BATCH) {
      chunks.push(ids.slice(i, i + MAX_MEDIA_IMAGES_BATCH));
    }

    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(50);
    expect(chunks[1]?.length).toBe(50);
    expect(chunks[2]?.length).toBe(25);
  });

  it('handles empty mediaIds without throwing', () => {
    const ids: string[] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += MAX_MEDIA_IMAGES_BATCH) {
      chunks.push(ids.slice(i, i + MAX_MEDIA_IMAGES_BATCH));
    }
    expect(chunks).toEqual([]);
  });
});
