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
 *   when it is null or left out (D-98, D-122).
 * - The verification records the device holds are not here yet. S-15 adds them along with the
 *   check that reads them and its 409 `unverified` (D-122).
 */
export const PreflightUploadRequest = z.object({
  contentHash: ContentHash,
  subEventId: z.uuid(),
  capturedAt: Timestamp.nullish(),
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
 *   capture time and role whatever this request sent. A soft-deleted unfinished row never
 *   resumes, and the photo gets a new row (D-122).
 *
 * The other answers, each the error body from Handbook §5.3, in the order the API checks:
 * - 404 `not_found` when the event is soft-deleted or unknown. 403 `not_member` when the caller is
 *   not an `active` member: pending, blocked, removed or never a member.
 * - 409 `album_closed` when the album is closed. S-12 builds this check switched off, and S-31
 *   switches it on (D-122).
 * - 409 `sub_event_missing` when the sub-event is not one of this event's, or was deleted after
 *   the photo was queued (D-122).
 * - 409 `duplicate` when a finished photo in this event has the hash, a soft-deleted one included
 *   (D-96), unless the caller has an unfinished row with the hash, which resumes first (D-122).
 *   The app drops the photo from its queue with no prompt.
 * - 422 `event_full` when the event already holds 2,000 media rows that are not soft-deleted,
 *   unfinished ones included (spec §4.17). A resume skips this check.
 * - 422 `too_many_unfinished` when the caller already holds 50 unfinished rows in this event that
 *   are not soft-deleted (D-122). A resume skips this check too.
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
 * not in the album yet. The worker sets `processed_at` last, and Realtime then delivers the row
 * (D-55).
 *
 * The other answers, in the order the API checks (D-122):
 * - 409 `duplicate` when no row has this id, which only a duplicate completion causes, or when the
 *   row was soft-deleted. The app drops the photo with no prompt (D-122).
 * - 403 `not_uploader` to anyone but the uploader. Then 404 `not_found` when the event was deleted
 *   since pre-flight, then 403 `not_member` to an uploader who is no longer an `active` member.
 * - 409 `upload_missing` when either object is not in R2 or is empty. The row stays unfinished,
 *   nothing is enqueued, and the app uploads both files again. Once the PUT URLs have expired, it
 *   gets fresh ones from a pre-flight, which resumes the row (arch §3, arch §4).
 * - 409 `duplicate` when another finished row in the event already has the hash. The API has
 *   deleted this row and its two objects, and the app drops the photo with no prompt (D-96).
 */
export const CompleteUploadResponse = z.object({
  status: z.literal('completed'),
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;

/** The most media ids one status read accepts (arch:media, D-145). */
export const MAX_MEDIA_STATUS_BATCH = 50;

/**
 * An uploaded photo is `processing` until the worker sets `processed_at` last, then `published`.
 * `deleted` takes precedence over both once `deleted_at` is set (root invariant 1, D-145).
 */
export const MediaPublishState = z.enum(['processing', 'published', 'deleted']);
export type MediaPublishState = z.infer<typeof MediaPublishState>;

/**
 * POST /events/{eventId}/media/status, for every active role (arch:media, D-145).
 * The path identifies the event; the body names 1 to 50 distinct media ids.
 * A UUID's upper-case and lower-case spellings identify the same row in Postgres.
 * An empty batch, an oversized batch or a repeated id answers 400 `invalid_request`.
 */
export const MediaStatusRequest = z.strictObject({
  mediaIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_MEDIA_STATUS_BATCH)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'A media id appears more than once',
    }),
});
export type MediaStatusRequest = z.infer<typeof MediaStatusRequest>;

/**
 * POST /events/{eventId}/media/status. A 200 with only the caller's finished rows in this event.
 * Another uploader's row, another event's row, an unfinished row or an unknown id is omitted.
 * An empty result is valid. Match entries by `mediaId`, with no promised order (D-145).
 * The body carries no image, object key or URL.
 *
 * Refusals use the existing `ErrorResponse` (hb §5.3): 401 `no_session`, 404 `not_found` for
 * an unknown or deleted event, then 403 `not_member` for a caller whose membership is not active.
 * No role, album state or sub-event timing check limits this read.
 */
export const MediaStatusResponse = z.object({
  statuses: z
    .array(
      z.object({
        mediaId: z.uuid(),
        status: MediaPublishState,
      }),
    )
    .max(MAX_MEDIA_STATUS_BATCH),
});
export type MediaStatusResponse = z.infer<typeof MediaStatusResponse>;
