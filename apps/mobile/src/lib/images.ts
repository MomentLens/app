import type { PresignedImage } from '@momentlens/shared-types';
import type { ImageSource } from 'expo-image';

// The expo-image source for a presigned image. It caches under the key the API returned and never
// under the URL, which changes on every request and lives one hour (arch §3, root invariant 2).
export function presignedSource(image: PresignedImage): ImageSource {
  return { uri: image.url, cacheKey: image.cacheKey };
}
