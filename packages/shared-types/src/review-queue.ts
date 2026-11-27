import { z } from 'zod';

import { BlurRegion } from './blur-region';
import { EventName, Timestamp } from './event';
import { AlbumMediaItem } from './media';

/** The most items one Review Queue page holds (D-181). */
export const MAX_REVIEW_QUEUE_PAGE = 50;

/**
 * GET /events/{eventId}/review-queue/flags, for the event's active Admin only (spec §2.5.7,
 * arch:photo_flag, D-181). Query parameters, with no body. The path identifies the event.
 *
 * - Returns keyset-paginated pages of up to 50 photos that have at least one `open` `photo_flag`,
 *   requiring `media.processed_at IS NOT NULL AND media.deleted_at IS NULL`, newest open flag
 *   first (by `latestFlaggedAt` descending, then `media.id` descending).
 * - Allowed while the album is closed or the event is archived.
 * - `cursor` is the opaque keyset cursor the previous page returned. The API validates its
 *   encoding; a tampered or mismatched cursor is 400 `invalid_request`.
 *
 * Refusals, in order (hb §5.3):
 * - 401 `no_session` when unauthenticated.
 * - 400 `invalid_request` for a non-uuid `eventId`, an unknown query key, or an invalid `cursor`.
 * - 404 `not_found` for an unknown or soft-deleted event.
 * - 403 `not_member` for anyone whose membership in the event is not `active`.
 * - 403 `wrong_role` for an active Guest or Photographer.
 */
export const ListFlaggedPhotosRequest = z.strictObject({
  cursor: z.string().min(1).optional(),
});
export type ListFlaggedPhotosRequest = z.infer<typeof ListFlaggedPhotosRequest>;

/**
 * One collapsed Flagged Photos card in the Admin's Review Queue (spec §2.5.7, D-181).
 *
 * - Open flags on the same published photo collapse into one entry without naming who flagged
 *   it. `flagCount` counts open flags on this photo and `latestFlaggedAt` is the newest open
 *   flag timestamp.
 * - `media` carries `AlbumMediaItem` metadata so `/review-flag/[eventId]/[mediaId]` can reuse
 *   the single-photo pager and image-signing flow; thumbnails and full images come from
 *   `POST /events/{eventId}/media/images`, never from URLs or object keys here (root invariants
 *   2 and 3).
 */
export const FlaggedPhoto = z.object({
  media: AlbumMediaItem,
  subEventName: EventName,
  flagCount: z.int().positive(),
  latestFlaggedAt: Timestamp,
});
export type FlaggedPhoto = z.infer<typeof FlaggedPhoto>;

/**
 * GET /events/{eventId}/review-queue/flags. A 200 with one page of flagged photos.
 *
 * - `openCount` is the total number of distinct live published photos with at least one `open`
 *   flag in this event, returned on every page so the two-segment switcher stays current.
 * - `nextCursor` is null on the last page.
 */
export const ListFlaggedPhotosResponse = z.object({
  photos: z.array(FlaggedPhoto).max(MAX_REVIEW_QUEUE_PAGE),
  openCount: z.int().nonnegative(),
  nextCursor: z.string().min(1).nullable(),
});
export type ListFlaggedPhotosResponse = z.infer<typeof ListFlaggedPhotosResponse>;

/**
 * POST /media/{mediaId}/flags/keep, for the event's active Admin only, with no body (spec §2.5.7,
 * arch:photo_flag, D-181). Served by `keep_photo_flags(p_media_id, p_user_id)` under event and
 * media share locks, marking every currently `open` flag on the photo `kept` in one transaction.
 *
 * - Answers 200 `{ mediaId, keptCount }`, with `keptCount: 0` idempotently when the photo is
 *   already free of `open` flags (including a repeat Keep or concurrent Keep).
 * - Allowed while the album is closed or the event is archived.
 *
 * Refusals, in order (hb §5.3):
 * - 401 `no_session` when unauthenticated.
 * - 400 `invalid_request` for a non-uuid `mediaId`.
 * - 404 `not_found` for an unknown, unprocessed or soft-deleted photo, or a soft-deleted event.
 * - 403 `not_member` for a non-active member of the photo's event.
 * - 403 `wrong_role` for an active Guest or Photographer.
 */
export const KeepPhotoFlagsResponse = z.object({
  mediaId: z.uuid(),
  keptCount: z.int().nonnegative(),
});
export type KeepPhotoFlagsResponse = z.infer<typeof KeepPhotoFlagsResponse>;

/**
 * GET /events/{eventId}/review-queue/blur-regions, for the event's active Admin only
 * (spec §2.5.7, arch:manual_blur_region, D-181). Query parameters, with no body.
 *
 * - Returns keyset-paginated pages of up to 50 `open` Guest-drawn blur regions on live published
 *   photos (`media.processed_at IS NOT NULL AND media.deleted_at IS NULL`), newest first (by
 *   `createdAt` descending, then `region.id` descending). Admin-drawn regions start `kept` and
 *   do not appear here.
 * - Allowed while the album is closed or the event is archived.
 *
 * Refusals follow `GET /events/{eventId}/review-queue/flags`.
 */
export const ListReviewBlurRegionsRequest = z.strictObject({
  cursor: z.string().min(1).optional(),
});
export type ListReviewBlurRegionsRequest = z.infer<typeof ListReviewBlurRegionsRequest>;

/**
 * Minimal photo metadata paired with an open blur region for natural-aspect-ratio thumbnail
 * framing, `variantVersion`-keyed image signing, and full-size preview (D-181, root invariants 2
 * and 3). Carries zero URLs or object keys.
 */
export const ReviewBlurRegionMedia = z.object({
  id: z.uuid(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  variantVersion: z.int().nonnegative(),
});
export type ReviewBlurRegionMedia = z.infer<typeof ReviewBlurRegionMedia>;

/**
 * One open Guest-drawn blur region in the Admin's Review Queue (spec §2.5.7, D-181). Reuses
 * `BlurRegion` directly for S-19's geometry helpers (`fromFractions`) and drawer attribution
 * (D-170).
 */
export const ReviewBlurRegion = z.object({
  region: BlurRegion,
  media: ReviewBlurRegionMedia,
});
export type ReviewBlurRegion = z.infer<typeof ReviewBlurRegion>;

/**
 * GET /events/{eventId}/review-queue/blur-regions. A 200 with one page of open blur regions.
 *
 * - `openCount` is the total number of `open` blur regions on live published photos in this
 *   event, returned on every page.
 * - `nextCursor` is null on the last page.
 */
export const ListReviewBlurRegionsResponse = z.object({
  regions: z.array(ReviewBlurRegion).max(MAX_REVIEW_QUEUE_PAGE),
  openCount: z.int().nonnegative(),
  nextCursor: z.string().min(1).nullable(),
});
export type ListReviewBlurRegionsResponse = z.infer<typeof ListReviewBlurRegionsResponse>;

/**
 * POST /blur-regions/{regionId}/keep, for the event's active Admin only, with no body
 * (spec §2.5.7, arch:manual_blur_region, D-181). Served by `keep_blur_region(p_region_id,
 * p_user_id)` under event and media share locks, setting `state = 'kept'` so the region leaves
 * the Review Queue while staying active on the photo and applied on every regeneration (root
 * invariant 6).
 *
 * - Answers 200 `{ regionId, state: 'kept' }`, idempotently when already `kept` on a live
 *   published photo.
 * - Allowed while the album is closed or the event is archived.
 *
 * Refusals, in order (hb §5.3):
 * - 401 `no_session` when unauthenticated.
 * - 400 `invalid_request` for a non-uuid `regionId`.
 * - 404 `not_found` for an unknown or removed region, an unprocessed or soft-deleted photo, or a
 *   soft-deleted event.
 * - 403 `not_member` for a non-active member of the region's event.
 * - 403 `wrong_role` for an active Guest or Photographer.
 */
export const KeepBlurRegionResponse = z.object({
  regionId: z.uuid(),
  state: z.literal('kept'),
});
export type KeepBlurRegionResponse = z.infer<typeof KeepBlurRegionResponse>;
