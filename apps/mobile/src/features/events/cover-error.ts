// Why a cover's PUT to R2 failed, decided where the upload runs (features/events/cover.ts) so a
// screen can tell the Admin what will help. Kept apart from cover.ts, which loads native modules,
// so code that only reads the reason can be tested without them.
//
// - file_missing: the prepared JPEG is gone from the cache, so only picking the photo again helps
// - unreachable: the PUT never got an answer from R2
// - refused: R2 answered with something other than 2xx, such as a presign that expired
export type CoverUploadFailure = 'file_missing' | 'unreachable' | 'refused';

export class CoverUploadError extends Error {
  readonly failure: CoverUploadFailure;

  constructor(failure: CoverUploadFailure, message: string) {
    super(message);
    this.name = 'CoverUploadError';
    this.failure = failure;
  }
}
