import { z } from 'zod';

/**
 * A private R2 object presigned for one requester, after the endpoint returning it has checked
 * that this requester may see it (root invariant 3). The URL lives one hour (arch §3).
 *
 * The app caches the image under `cacheKey` and never under `url`, which changes on every
 * request. For an avatar or a cover the cache key is the object key, which carries a fresh
 * `upload_id` per replacement. For a media file it is the object key plus `variant_version`
 * (root invariant 2).
 */
export const PresignedImage = z.object({
  url: z.url({ protocol: /^https$/ }),
  cacheKey: z.string().min(1),
});
export type PresignedImage = z.infer<typeof PresignedImage>;
