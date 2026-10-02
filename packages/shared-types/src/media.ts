import { z } from 'zod';

import { Timestamp } from './event';

/**
 * A photo's content hash: SHA-256 over the exact bytes the phone uploads, after the EXIF strip and
 * the JPEG conversion, as 64 lower-case hex characters (root invariant 7). Never the thumbnail's,
 * because WebP encoders differ across platforms (D-53).
 */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);
export type ContentHash = z.infer<typeof ContentHash>;

/**
 * POST /events/{eventId}/media/preflight, for every active role alike: Admin, Guest and
 * Photographer (D-58). JSON only, with no image bytes, the thumbnail included (D-69).
 *
 * - `subEventId` must be a sub-event of the event in the path. The row's `event_id` comes from the
 *   path's event and never from the body (D-122).
 * - `capturedAt` is the photo's EXIF capture time in UTC. The phone converts an EXIF time with no
 *   zone before sending it. Any instant is accepted, and the API uses the time of the pre-flight
 *   when it is left out (D-98, D-122).
 * - The verification records the device holds are not here yet. S-15 adds them along with the
 *   check that reads them and its 409 `unverified` (D-122).
 */
export const PreflightUploadRequest = z.object({
  contentHash: ContentHash,
  subEventId: z.uuid(),
  capturedAt: Timestamp.optional(),
});
export type PreflightUploadRequest = z.infer<typeof PreflightUploadRequest>;

/**
 * POST /events/{eventId}/media/preflight. A 201 when this call created the media row, and a 200
 * when it resumed the caller's own unfinished row with the same hash (D-82, D-122).
 *
 * - The app PUTs the photo to `photoUploadUrl` with `Content-Type: image/jpeg` and the thumbnail to
 *   `thumbnailUploadUrl` with `Content-Type: image/webp`, one after the other, within 15 minutes
 *   (arch §3), then calls POST /media/{mediaId}/complete. A PUT that fails or expires sends the
 *   photo back to pre-flight, which resumes the same row.
 * - The API built both object keys from `mediaId` and stored them on the row, so the app never
 *   sees or sends a key (root invariant 12).
 * - A resume returns the row's existing id and keys, re-signed, and keeps its own sub-event,
 *   capture time and role whatever this request sent (D-122).
 *
 * The other answers, each the error body from Handbook §5.3, in the order the API checks:
 * - 404 `not_found` when the event is soft-deleted or unknown. 403 `not_member` when the caller is
 *   not an `active` member: pending, blocked, removed or never a member.
 * - 409 `album_closed` when the album is closed. S-12 builds this check switched off, and S-31
 *   switches it on (D-122).
 * - 409 `sub_event_missing` when the sub-event is not one of this event's, or was deleted after
 *   the photo was queued (D-122).
 * - 409 `duplicate` when a finished photo in this event has the hash, a soft-deleted one included
 *   (D-96). The app drops the photo from its queue with no prompt.
 * - 422 `event_full` when the event already holds 2,000 media rows that are not soft-deleted,
 *   unfinished ones included (spec §4.17). A resume skips this check.
 */
export const PreflightUploadResponse = z.object({
  mediaId: z.uuid(),
  photoUploadUrl: z.url({ protocol: /^https$/ }),
  thumbnailUploadUrl: z.url({ protocol: /^https$/ }),
});
export type PreflightUploadResponse = z.infer<typeof PreflightUploadResponse>;

/**
 * POST /media/{mediaId}/complete, by the photo's uploader, with no body. The API HEADs both objects
 * in R2, then marks the row uploaded and enqueues its processing job in one transaction (D-95).
 *
 * A 200 means the photo is uploaded. A repeat answers 200 again and enqueues nothing. The photo is
 * not in the album yet: the worker sets `processed_at` last, and Realtime then delivers the row
 * (D-55).
 *
 * The other answers, in the order the API checks (D-122):
 * - 409 `duplicate` when no row has this id, because a duplicate completion is the only thing
 *   that deletes one.
 * - 403 `not_uploader` to anyone but the uploader. 403 `not_member` to an uploader who is no
 *   longer an `active` member, and 404 `not_found` when the event was deleted since pre-flight.
 * - 409 `upload_missing` when either object is not in R2. The row stays unfinished, nothing is
 *   enqueued, and the app uploads both files again (arch §4).
 * - 409 `duplicate` when another finished row in the event already has the hash. The API has
 *   deleted this row and its two objects, and the app drops the photo with no prompt (D-96).
 */
export const CompleteUploadResponse = z.object({
  status: z.literal('completed'),
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;
