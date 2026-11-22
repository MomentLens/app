// Why a photo's PUT to R2 failed, for a profile photo and a reference photo alike. Kept apart from
// put-jpeg.ts, which loads native modules, so code that only reads the reason can be tested
// without them. The cover keeps its own CoverUploadError (features/events/cover-error.ts).
//
// - file_missing: the prepared JPEG is gone from the cache, so only picking the photo again helps
// - unreachable: the PUT never got an answer from R2
// - refused: R2 answered with something other than 2xx, such as a presign that expired
export type PhotoUploadFailure = 'file_missing' | 'unreachable' | 'refused';

export class PhotoUploadError extends Error {
  readonly failure: PhotoUploadFailure;

  constructor(failure: PhotoUploadFailure, message: string) {
    super(message);
    this.name = 'PhotoUploadError';
    this.failure = failure;
  }
}
