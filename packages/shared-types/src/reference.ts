import { z } from 'zod';

import { Timestamp } from './event';
import { PresignedImage } from './image';

/**
 * The most reference photos one person keeps in one event that are not rejected (spec §4.2). A
 * rejected one does not count, so the owner can replace it without deleting it first.
 */
export const MAX_REFERENCES_PER_EVENT = 5;

/**
 * `face_reference.status` (arch:face_reference). The API inserts a row as `pending`, and
 * `reference_process` decides it within seconds. Only `accepted` rows are matched against or
 * counted toward Do Not Publish (D-87, D-91).
 */
export const ReferenceStatus = z.enum(['pending', 'accepted', 'rejected']);
export type ReferenceStatus = z.infer<typeof ReferenceStatus>;

/**
 * Why `reference_process` rejected a reference (D-91, D-172).
 * - `no_face` and `multiple_faces`: the worker counted the faces at SCRFD's default score, 0.5,
 *   with no minimum size (arch §6). For `multiple_faces` the app shows spec §4.2's message.
 * - `failed`: the job failed three times, so nobody checked the photo. The app says it could not
 *   be checked, and the owner deletes it and tries again.
 */
export const ReferenceRejectReason = z.enum(['no_face', 'multiple_faces', 'failed']);
export type ReferenceRejectReason = z.infer<typeof ReferenceRejectReason>;

/**
 * One of the caller's reference photos in one event. A reference is shown to its owner alone,
 * the Admin included, so every endpoint below answers about the caller's own rows and nobody
 * else's (spec §4.2, arch §3). The embedding never leaves the server.
 *
 * `rejectReason` is set exactly when `status` is `rejected`, as the table's check constraint
 * requires. `image` is the reference photo presigned for its owner; its `cacheKey` is the object
 * key, which carries the reference's own id, so no two references share a cache entry.
 */
export const Reference = z
  .object({
    id: z.uuid(),
    status: ReferenceStatus,
    rejectReason: ReferenceRejectReason.nullable(),
    image: PresignedImage,
    createdAt: Timestamp,
  })
  .refine((r) => (r.status === 'rejected') === (r.rejectReason !== null), {
    message: 'rejectReason is set exactly when status is rejected',
    path: ['rejectReason'],
  });
export type Reference = z.infer<typeof Reference>;

/**
 * GET /events/{eventId}/references, with no body: every reference the caller has in this event,
 * of any status, sorted by `createdAt`, then `id`, oldest first. It holds no other person's rows,
 * and none from another event (D-141).
 *
 * PUT and DELETE below answer 200 or 201 with this same body, the list after the write, so the
 * app replaces its cached list with it. `face_reference` has no Realtime, so while any row is
 * `pending` the app polls this GET (D-91, root invariant 14).
 *
 * Every reference endpoint refuses in this order:
 * - 400 `invalid_request` for a path id that is not a uuid.
 * - 404 `not_found` for a soft-deleted or unknown event.
 * - 403 `not_member` for a caller who is not an active member of the event: pending, blocked,
 *   removed, or never joined. Every role may keep references. A removed member's rows stay, so a
 *   rejoin matches them again (D-84).
 */
export const ListReferencesResponse = z.object({
  references: z.array(Reference),
});
export type ListReferencesResponse = z.infer<typeof ListReferencesResponse>;

/**
 * POST /events/{eventId}/references/upload, with no body.
 *
 * After the refusals above, it answers 422 `too_many_references` when the caller already has
 * `MAX_REFERENCES_PER_EVENT` references in this event that are not rejected. PUT checks again
 * under a lock, because two uploads can pass this check at once (D-95).
 *
 * The app runs the photo through arch §4.1's Stage 1 (orientation applied, every EXIF field
 * stripped, JPEG at quality 0.9) and PUTs it to `uploadUrl` with `Content-Type: image/jpeg` within
 * 15 minutes, then calls PUT /events/{eventId}/references/{uploadId} (D-172). The API builds the
 * object key from the caller, the event and `uploadId`, so the app never sees or sends a key
 * (root invariant 12).
 */
export const CreateReferenceUploadResponse = z.object({
  uploadId: z.uuid(),
  uploadUrl: z.url({ protocol: /^https$/ }),
});
export type CreateReferenceUploadResponse = z.infer<typeof CreateReferenceUploadResponse>;

/**
 * PUT /events/{eventId}/references/{uploadId}, with no body. The `uploadId` from POST becomes the
 * reference's `id`. It inserts the row as `pending` and enqueues `reference_process` in one
 * transaction, through `add_face_reference`, and answers 201 with `ListReferencesResponse`.
 *
 * After the refusals on `ListReferencesResponse`:
 * - 404 `not_found` when the id already names a reference of another person or another event.
 * - A repeat for the caller's own reference in this event answers 200 with the list and changes
 *   nothing, so a resend after a lost answer is safe. It enqueues no second job.
 * - 409 `upload_missing` when the object is not in R2. The API HEADs it before the insert.
 * - 422 `too_many_references`, counted under the lock in `add_face_reference` (D-95).
 */

/**
 * DELETE /events/{eventId}/references/{referenceId}, with no body. It deletes the row, with its
 * embedding, then the object, and answers 200 with `ListReferencesResponse`. Until S-25 it
 * enqueues no `reprocess`, and until S-29 it does not refuse the last accepted reference (D-172).
 *
 * After the refusals on `ListReferencesResponse`, 404 `not_found` for an unknown reference, one
 * already deleted, or one of another person or another event. The app treats a 404 on a delete
 * as done, so a resend after a lost answer is safe.
 */
