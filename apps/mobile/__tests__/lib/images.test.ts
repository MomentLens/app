import { describe, expect, it } from '@jest/globals';

import { presignedSource } from '@/lib/images';

describe('presignedSource', () => {
  it('caches under the API cache key, not the URL, which changes every hour', () => {
    const image = { url: 'https://r2.example.test/get?sig=abc', cacheKey: 'events/e/cover_u.jpg' };
    expect(presignedSource(image)).toEqual({ uri: image.url, cacheKey: 'events/e/cover_u.jpg' });
  });
});
