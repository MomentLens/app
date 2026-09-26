import type { PresignedImage } from '@momentlens/shared-types';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { DraftCover } from '@/features/events/draft';
import { createCoverUpload, setEventCover } from '@/lib/api';

// The longest edge the app sends, the one client-side resize root invariant 9 allows.
const MAX_EDGE_PX = 4096;
const JPEG_QUALITY = 0.9;
// The content type the API signed the PUT with (apps/api/src/lib/r2.ts). R2 refuses any other.
const COVER_CONTENT_TYPE = 'image/jpeg';

// A picked photo as the JPEG the cover upload sends. Re-encoding writes new pixels with none of
// the source's metadata, so a HEIC or PNG becomes a JPEG and the photo's EXIF, GPS included,
// never reaches the members who see the cover. Only an image over 4096 px is shrunk.
export async function prepareCover(uri: string): Promise<DraftCover> {
  const context = ImageManipulator.manipulate(uri);
  let image = await context.renderAsync();
  if (Math.max(image.width, image.height) > MAX_EDGE_PX) {
    context.resize(image.width >= image.height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX });
    image = await context.renderAsync();
  }
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}

// Uploads a prepared cover for an event that exists, then sets it (D-110, arch §3). The file goes
// from the phone straight to R2 on the presigned URL, never through the API (root invariant 5),
// and carries only the signed content type, never the API's access token. The API is told the
// uploadId and builds the key itself (root invariant 12).
export async function uploadCover(eventId: string, cover: DraftCover): Promise<PresignedImage> {
  const { uploadId, uploadUrl } = await createCoverUpload(eventId);
  const result = await new File(cover.uri).upload(uploadUrl, {
    httpMethod: 'PUT',
    headers: { 'Content-Type': COVER_CONTENT_TYPE },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`R2 refused the cover upload with HTTP ${result.status}.`);
  }
  const { cover: presigned } = await setEventCover(eventId, uploadId);
  return presigned;
}
