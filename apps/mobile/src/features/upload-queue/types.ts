// S-10 stores these states. S-11 owns the transitions in arch §4.
export type QueueState =
  | 'queued'
  | 'waiting_album'
  | 'waiting_verification'
  | 'uploading'
  | 'uploaded'
  | 'published'
  | 'stopped'
  | 'local_only';
export type QueueStep = 'prepare' | 'preflight' | 'put_photo' | 'put_thumbnail' | 'complete';
// The two states a release moves back to queued: S-31 for the album, S-15 for verification (D-146).
export type WaitingState = 'waiting_album' | 'waiting_verification';
export type StoppedReason =
  | 'event_full'
  | 'too_many_unfinished'
  | 'sub_event_missing'
  | 'invalid_request'
  | 'not_uploader'
  | 'not_member'
  | 'not_found';

export interface QueueItem {
  id: string;
  userId: string;
  eventId: string;
  subEventId: string;
  photoPath: string | null;
  thumbnailPath: string;
  photoUri: string | null;
  thumbnailUri: string;
  capturedAt: string | null;
  createdAt: number;
  state: QueueState;
  step: QueueStep;
  mediaId: string | null;
  contentHash: string | null;
  retryCount: number;
  nextRetryAt: number | null;
  stoppedReason: StoppedReason | null;
}
export type QueuePatch = Partial<
  Pick<
    QueueItem,
    'state' | 'step' | 'mediaId' | 'contentHash' | 'retryCount' | 'nextRetryAt' | 'stoppedReason'
  >
>;
export interface QueuePhoto {
  uri: string;
  capturedAt: string | null;
}
export interface QueueCounts {
  waiting: number;
  uploading: number;
}
