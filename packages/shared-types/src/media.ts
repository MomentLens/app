import { z } from 'zod';

import { MembershipRole, Timestamp } from './event';
import { PresignedImage } from './image';
import { FullName } from './profile';
import { VerificationRecords } from './verification';

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
 * - `verifications` carries the GPS readings this account holds for this event, at most 15.
 *   Each names its own sub-event, which may differ from the photo's. The API judges each reading
 *   at its own time, and `start_upload` records accepted check-ins before its photo checks
 *   (D-155). Omitting the list or sending an empty one supplies no new check-in.
 */
export const PreflightUploadRequest = z.object({
  contentHash: ContentHash,
  subEventId: z.uuid(),
  capturedAt: Timestamp.nullish(),
  verifications: VerificationRecords.optional(),
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
 * - 409 `unverified` when a new upload has no check-in for this user and sub-event, no manual
 *   check-in and no exempt role. Admin and Photographer pass. A resume skips this check (D-155).
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

/** The most media ids one serving batch accepts (D-148). */
export const MAX_MEDIA_IMAGES_BATCH = 50;

/** The most media rows one album page holds (D-148). */
export const MAX_ALBUM_PAGE = 50;

/**
 * Whether the caller wants a thumbnail or the full display image (D-148). The serving endpoint
 * reads the corresponding column on the `media` row (`public_thumb_key` or `public_key`).
 * S-21 extends this to pick the subject's own variant when one exists.
 */
export const MediaImageSize = z.enum(['thumbnail', 'full']);
export type MediaImageSize = z.infer<typeof MediaImageSize>;

/**
 * GET /events/{eventId}/media, for every active role except Photographer (D-148). Query
 * parameters, with no body. The path identifies the event.
 *
 * - `subEventId` filters to one sub-event. The chip row sends it. Without it the album shows
 *   every sub-event's section.
 * - `uploaderId` filters to one uploader. The Uploader sheet sends it. Without it every uploader
 *   contributes.
 * - Both stack: an active chip plus an active uploader filter gives "Sarah's photos from the
 *   reception" (spec §2.5.2).
 * - `cursor` is the opaque keyset cursor the previous page returned. The first request leaves it
 *   out. The API validates its encoding; a tampered or stale cursor is 400 `invalid_request`.
 *
 * Refusals, in order: 401 `no_session`; 404 `not_found` for an unknown or deleted event; 403
 * `not_member` for a non-active member; 403 `wrong_role` for a Photographer (D-148).
 */
export const ListAlbumRequest = z.strictObject({
  subEventId: z.uuid().optional(),
  uploaderId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
});
export type ListAlbumRequest = z.infer<typeof ListAlbumRequest>;

/**
 * One photo in the album grid. The serving endpoint handles URLs; this carries only metadata
 * needed for layout, section headers and the tile.
 *
 * - `uploaderRole` is `uploader_role_at_upload`, display and filter metadata only (spec §4.4).
 * - `width` and `height` are the photo's pixel dimensions, written by the worker (D-22). They
 *   are null until the worker finishes; the album query already filters on `processed_at`, so a
 *   null here would mean a consistency bug, but the schema still allows it to stay forward-safe.
 * - `variantVersion` is the row's `variant_version`, bumped on every regeneration (D-60). The app
 *   asks the serving endpoint again for a photo whose version changed, so a retroactive blur
 *   replaces the tile instead of leaving the pre-blur thumbnail on screen (root invariant 2).
 */
export const AlbumMediaItem = z.object({
  id: z.uuid(),
  subEventId: z.uuid(),
  capturedAt: Timestamp,
  uploaderRole: MembershipRole,
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  variantVersion: z.int().nonnegative(),
});
export type AlbumMediaItem = z.infer<typeof AlbumMediaItem>;

/**
 * One sub-event section's photo count under the active filters, returned with the first page
 * so the grid can draw its section headers with counts before all pages are loaded (D-148).
 */
export const SectionCount = z.object({
  subEventId: z.uuid(),
  count: z.int().nonnegative(),
});
export type SectionCount = z.infer<typeof SectionCount>;

/**
 * GET /events/{eventId}/media. A 200 with one page of the album in D-148's section order:
 * sub-events by start ascending, then by id, and within each section `captured_at` descending,
 * then `id` descending.
 *
 * - `media` is the page, up to 50 rows.
 * - `sectionCounts` appears only on the first page (when the request carried no `cursor`) and
 *   holds the photo count for every sub-event that has at least one photo under the active
 *   filters. Subsequent pages set it to null so the app does not re-render its counts.
 * - `nextCursor` is null on the last page. The app sends it unchanged to fetch the next.
 */
export const ListAlbumResponse = z.object({
  media: z.array(AlbumMediaItem).max(MAX_ALBUM_PAGE),
  sectionCounts: z.array(SectionCount).nullable(),
  nextCursor: z.string().min(1).nullable(),
});
export type ListAlbumResponse = z.infer<typeof ListAlbumResponse>;

/**
 * POST /events/{eventId}/media/images, for every active role (D-148). The body names 1 to 50
 * distinct media ids and a `size`. The endpoint answers with a presigned URL and cache key for
 * each id the caller may see, and silently omits every other id.
 *
 * A Photographer gets only their own published photos signed. A Guest or Admin gets every
 * published photo in the event. No id that has no `processed_at` is ever signed, the uploader
 * included (D-148, root invariant 1).
 *
 * Refusals, in order: 401 `no_session`; 404 `not_found` for an unknown or deleted event; 403
 * `not_member` for a non-active member. No role check: every active role may call it, the
 * Photographer included, who receives only their own photos (arch §1).
 * 400 `invalid_request` for a body that fails validation: empty, oversized, or repeated ids.
 *
 * S-21 adds the own-variant flag (`isOwnVariant`) to each entry, and picks the subject's file
 * when the requester is a Do Not Publish subject in that photo. Until then, every entry carries
 * the public file only.
 */
export const MediaImagesRequest = z.strictObject({
  mediaIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_MEDIA_IMAGES_BATCH)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'A media id appears more than once',
    }),
  size: MediaImageSize,
});
export type MediaImagesRequest = z.infer<typeof MediaImagesRequest>;

/**
 * One image the serving endpoint returned. `cacheKey` is the signed object key, then `#v`,
 * then `variant_version` (D-148, D-86, root invariant 2). The app caches under it, never under
 * `url`, which rotates hourly.
 *
 * S-21 adds `isOwnVariant: boolean` here. Until then every image is the public file.
 */
export const MediaImage = PresignedImage;
export type MediaImage = z.infer<typeof MediaImage>;

/**
 * POST /events/{eventId}/media/images. A 200 with the signed images the caller may see. Each
 * entry is keyed by its media id. An id the caller may not see, or one with no public file yet,
 * is absent from the map, with no error and no null.
 */
export const MediaImagesResponse = z.object({
  images: z.record(z.uuid(), MediaImage),
});
export type MediaImagesResponse = z.infer<typeof MediaImagesResponse>;

/**
 * One uploader in the Uploader filter sheet: an active member of this event who has at least one
 * published photo. A removed or blocked uploader is left off the list, and their photos stay
 * visible under All (D-148).
 *
 * `avatar` is null for everyone until S-29 adds event-scoped avatar privacy (D-143, D-148).
 */
export const Uploader = z.object({
  userId: z.uuid(),
  fullName: FullName,
  role: MembershipRole,
  photoCount: z.int().positive(),
  avatar: PresignedImage.nullable(),
});
export type Uploader = z.infer<typeof Uploader>;

/**
 * GET /events/{eventId}/media/uploaders, for every active role except Photographer (D-148).
 * The request has no body and no query parameters. The app searches the list client-side, since
 * an event holds at most about 150 members.
 *
 * Refusals, in order: 401 `no_session`; 404 `not_found` for an unknown or deleted event; 403
 * `not_member` for a non-active member; 403 `wrong_role` for a Photographer (D-148).
 */
export const ListUploadersResponse = z.object({
  uploaders: z.array(Uploader),
});
export type ListUploadersResponse = z.infer<typeof ListUploadersResponse>;
