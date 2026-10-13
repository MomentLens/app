import { z } from 'zod';

import { FullName } from './profile';

/**
 * GET /events/{eventId}/album, for the event's Admin only (D-161). Manage's status card reads it,
 * and the Close Album dialog fetches it again when it opens (spec §4.9). The request has no body.
 * One `album_status` call reads all three fields from one snapshot.
 *
 * - `albumOpen` is the album's state, as `EventSummary.albumOpen` carries it.
 * - `uploadCount` counts the event's media rows with `uploaded_at` set and no `deleted_at`: every
 *   finished upload still in the event, processed by the worker or not.
 * - `photographersWithoutUploads` names every `active` Photographer who holds no such row, sorted
 *   by name. The Close Album dialog names each one, so the list has no cap.
 *
 * The API refuses in this order, and a refusal carries the error body and nothing else:
 *
 * - 400 `invalid_request` for a path id that is not a uuid.
 * - 404 `not_found` for a soft-deleted or unknown event, its Admin included.
 * - 403 `not_member` for anyone whose membership is not `active`: pending, removed, blocked or
 *   never a member, another event's Admin included.
 * - 403 `wrong_role` for a Guest or a Photographer. The app refetches the event and the Event
 *   shell redraws its tabs (hb §5.3).
 *
 * An archived event answers as any other (D-142).
 */
export const AlbumStatusResponse = z.object({
  albumOpen: z.boolean(),
  uploadCount: z.int().min(0),
  photographersWithoutUploads: z.array(FullName),
});
export type AlbumStatusResponse = z.infer<typeof AlbumStatusResponse>;

/**
 * PUT /events/{eventId}/album, for the event's Admin only (D-161). `open` is the state to set:
 * true opens the album and false closes it.
 *
 * - The API checks the path and the body first. A missing or non-boolean `open`, or any other
 *   field, is a 400 `invalid_request`. Then it refuses as GET does, and a refused PUT changes
 *   nothing.
 * - A repeat sets the same state again and answers the same, so a resend is safe. Two of the
 *   Admin's phones resolve as last write wins (D-142).
 * - An archived event takes it. An event soft-deleted after the membership check is a 404
 *   `not_found`, because the update skips a deleted row.
 * - The app sends it only with a connection and never queues it.
 */
export const SetAlbumRequest = z.strictObject({
  open: z.boolean(),
});
export type SetAlbumRequest = z.infer<typeof SetAlbumRequest>;

/** PUT /events/{eventId}/album. `albumOpen` is the state this call set. */
export const SetAlbumResponse = z.object({
  albumOpen: z.boolean(),
});
export type SetAlbumResponse = z.infer<typeof SetAlbumResponse>;
