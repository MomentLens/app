import type { PresignedImage } from '@momentlens/shared-types';
import { File, type UploadResult } from 'expo-file-system';

import { CoverUploadError } from '@/features/events/cover-error';
import type { DraftCover } from '@/features/events/draft';
import { createCoverUpload, setEventCover } from '@/lib/api';
import { encodeUploadJpeg } from '@/lib/upload-jpeg';

// The content type the API signed the PUT with (apps/api/src/lib/r2.ts). R2 refuses any other.
const COVER_CONTENT_TYPE = 'image/jpeg';

// A picked photo as the JPEG the cover upload sends. Re-encoding writes new pixels with none of
// the source's metadata, so a HEIC or PNG becomes a JPEG and the photo's EXIF, GPS included,
// never reaches the members who see the cover. Only an image over 4096 px is shrunk.
export async function prepareCover(uri: string): Promise<DraftCover> {
  const saved = await encodeUploadJpeg(uri);
  return { uri: saved.uri, width: saved.width, height: saved.height };
}

// Uploads a prepared cover for an event that exists, then sets it (D-110, arch §3). The file goes
// from the phone straight to R2 on the presigned URL, never through the API (root invariant 5),
// and carries only the signed content type, never the API's access token. The API is told the
// uploadId and builds the key itself (root invariant 12).
//
// The two API calls throw ApiError, and the PUT to R2 throws CoverUploadError with its reason.
export async function uploadCover(eventId: string, cover: DraftCover): Promise<PresignedImage> {
  // The prepared JPEG sits in the cache, which the OS may clear while a screen stays open.
  // Checked first, so no upload is presigned for a file that is not there.
  const file = new File(cover.uri);
  if (!file.exists) {
    throw new CoverUploadError('file_missing', `The prepared cover at ${cover.uri} is gone.`);
  }
  const { uploadId, uploadUrl } = await createCoverUpload(eventId);
  let result: UploadResult;
  try {
    result = await file.upload(uploadUrl, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': COVER_CONTENT_TYPE },
    });
  } catch (error) {
    throw new CoverUploadError(
      'unreachable',
      `The cover upload did not reach R2: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new CoverUploadError(
      'refused',
      `R2 refused the cover upload with HTTP ${result.status}.`,
    );
  }
  const { cover: presigned } = await setEventCover(eventId, uploadId);
  return presigned;
}
