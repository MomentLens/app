import { File, type UploadResult } from 'expo-file-system';

import { PhotoUploadError } from '@/lib/photo-upload-error';

// The content type the API signs every photo PUT with (apps/api/src/lib/r2.ts). R2 refuses any
// other.
const JPEG_CONTENT_TYPE = 'image/jpeg';

// Sends a JPEG that encodeUploadJpeg already prepared to a presigned PUT. The bytes go from the
// phone straight to R2, never through the API (root invariant 5), and carry only the signed
// content type, never the API's access token. Throws PhotoUploadError with its reason.
export async function putJpeg(uri: string, uploadUrl: string): Promise<void> {
  const file = new File(uri);
  if (!file.exists) {
    throw new PhotoUploadError('file_missing', `The prepared photo at ${uri} is gone.`);
  }
  let result: UploadResult;
  try {
    result = await file.upload(uploadUrl, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': JPEG_CONTENT_TYPE },
    });
  } catch (error) {
    throw new PhotoUploadError(
      'unreachable',
      `The photo upload did not reach R2: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new PhotoUploadError(
      'refused',
      `R2 refused the photo upload with HTTP ${result.status}.`,
    );
  }
}
