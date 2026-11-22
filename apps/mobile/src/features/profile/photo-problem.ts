import { PhotoUploadError } from '@/lib/photo-upload-error';

// What to tell the person when a profile photo fails, on Profile and after signup. Free of native
// modules so it is tested on its own.
export function profilePhotoProblem(error: unknown): string {
  if (error instanceof PhotoUploadError && error.failure === 'file_missing') {
    return 'That photo is no longer on this phone. Pick it again.';
  }
  if ((error as { code?: string } | null)?.code === 'upload_missing') {
    return 'The photo did not finish uploading. Try again.';
  }
  return 'The profile photo could not be uploaded. Check the connection and try again.';
}
