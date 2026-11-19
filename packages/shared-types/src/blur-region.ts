import { z } from 'zod';

import { Timestamp } from './event';
import { FullName } from './profile';

/**
 * A rectangle on a photo, as fractions of the stored image: `x` and `y` are its top-left corner,
 * and `width` and `height` its size, all between 0 and 1. One rectangle fits every file the worker
 * writes for the photo, whatever its pixel size (D-99).
 *
 * - The rectangle has a size and stays on the image: `width` and `height` are above 0, and
 *   `x + width` and `y + height` are at most 1. `manual_blur_region`'s check constraint refuses
 *   the same rectangles, so a client that skips this schema still cannot store one.
 * - The app clamps a drag to the image before it sends one, because a rounding error at an edge
 *   would otherwise make `x + width` come out a hair above 1 and draw a 400.
 * - The server sets no minimum size. The drawing screen ignores a drag shorter than about 24
 *   points (D-170).
 */
const Fraction = z.number().min(0).max(1);

const rectShape = {
  x: Fraction,
  y: Fraction,
  width: Fraction.positive(),
  height: Fraction.positive(),
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function fitsTheImage<S extends z.ZodType<Rect>>(schema: S) {
  return schema
    .refine((r) => r.x + r.width <= 1, { message: 'x + width exceeds 1', path: ['width'] })
    .refine((r) => r.y + r.height <= 1, { message: 'y + height exceeds 1', path: ['height'] });
}

export const BlurRect = fitsTheImage(z.strictObject(rectShape));
export type BlurRect = z.infer<typeof BlurRect>;

/**
 * One stored blur region (arch:manual_blur_region). `drawnBy` names who drew it. A Guest only ever
 * receives their own, and the Admin uses the name to tell regions apart (D-170). A drawer who has
 * left the event keeps their regions and their name here.
 */
export const BlurRegion = z.object({
  id: z.uuid(),
  x: Fraction,
  y: Fraction,
  width: Fraction,
  height: Fraction,
  drawnBy: z.object({
    userId: z.uuid(),
    fullName: FullName,
  }),
  createdAt: Timestamp,
});
export type BlurRegion = z.infer<typeof BlurRegion>;

/**
 * POST /media/{mediaId}/blur-regions, for an active Guest or the event's Admin (spec §4.11.4.4).
 * It stores the region and enqueues `{ job: 'blur_region', media_id }` in one transaction, through
 * `add_blur_region` (arch §5). The region applies when that job finishes; until then every viewer
 * sees the previous file, and the drawing screen draws the rectangle solid (D-170).
 *
 * - `id` is made on the phone, so a resend after a lost answer stores nothing new and enqueues
 *   nothing new. A repeat of an id this caller already stored on this photo answers 200 with the
 *   list and leaves the stored rectangle as it was. An id already used by another person or
 *   another photo is 409 `duplicate`.
 * - A new region answers 201. Both answer `ListBlurRegionsResponse`, the list after the write.
 * - A closed album takes it, because closing the album blocks uploads only (D-170).
 *
 * The API refuses in this order, and a refusal carries the error body and nothing else:
 * - 400 `invalid_request` for a path id that is not a uuid, or a body `BlurRect` refuses, or any
 *   other field.
 * - 404 `not_found` for an unknown photo, a soft-deleted photo or event, or a photo the worker has
 *   not finished (no `processed_at`). The same answer when the photo is deleted while the screen is
 *   open, because `add_blur_region` locks the media row.
 * - 403 `not_member` for anyone whose membership in the photo's event is not `active`: pending,
 *   removed, blocked or never a member.
 * - 403 `wrong_role` for a Photographer (spec §4.11.4.4 names Guests and the Admin).
 * - 409 `duplicate` as above.
 */
export const AddBlurRegionRequest = fitsTheImage(z.strictObject({ id: z.uuid(), ...rectShape }));
export type AddBlurRegionRequest = z.infer<typeof AddBlurRegionRequest>;

/**
 * GET /media/{mediaId}/blur-regions, with no body, and the answer to POST and DELETE as well.
 *
 * - A Guest receives only the regions they drew on this photo, so they can remove one. The Admin
 *   receives every region on it (D-170).
 * - Sorted by `createdAt`, then `id`, oldest first. No cap: the server sets no limit per photo.
 * - GET refuses as POST does, with no `duplicate`.
 *
 * DELETE /blur-regions/{regionId}, with no body. It deletes the row and enqueues
 * `{ job: 'blur_region', media_id }` in one transaction, through `remove_blur_region`, so the
 * worker regenerates the photo's files without it (arch §5, root invariant 6). It answers 200 with
 * `ListBlurRegionsResponse` for the region's photo, the list after the delete, as GET would answer
 * the caller. It has no response schema of its own, as DELETE /sub-events/{subEventId} has none.
 *
 * The API refuses in this order:
 * - 400 `invalid_request` for a path id that is not a uuid.
 * - 404 `not_found` for an unknown region, which includes one already removed, and for a region
 *   whose photo is soft-deleted or unprocessed, or whose event is soft-deleted. The app treats a
 *   404 on a remove as done, so a resend after a lost answer is safe.
 * - 403 `not_member` and 403 `wrong_role` as POST does, by the photo's event.
 * - 403 `not_drawer` for a Guest removing a region someone else drew. The Admin can remove any
 *   region, a departed drawer's included (D-170).
 * - A closed album takes it.
 */
export const ListBlurRegionsResponse = z.object({
  regions: z.array(BlurRegion),
});
export type ListBlurRegionsResponse = z.infer<typeof ListBlurRegionsResponse>;
