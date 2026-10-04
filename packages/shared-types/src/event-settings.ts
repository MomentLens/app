import { z } from 'zod';

import { ApprovalMode, EventDescription, EventName } from './event';
import { PresignedImage } from './image';
import { FullName } from './profile';

/**
 * The Event Settings form's fields, and the requests a switch to auto would admit (D-142). Only
 * the Admin reads it, because `GET /events/{eventId}` carries neither the description nor
 * Approval Mode.
 *
 * - `description` is null when there is none. The database stores an empty one as null, so the
 *   API never sends an empty string.
 * - `cover` is null until a cover is set. It is the object `EventSummary.cover` presigns, under
 *   the same `cacheKey`.
 * - `pendingCount` counts every `pending` membership of the event, Guests and Photographers. It
 *   can be above zero on an `auto` event, holding the Guests the cap left waiting.
 * - `pendingPhotographers` names each pending Photographer, oldest `requested_at` first, for the
 *   confirm before a switch to auto (D-139). They count toward `pendingCount`.
 * - The type is not here. It is set at create and never changes (D-142).
 */
export const EventSettings = z
  .object({
    name: EventName,
    description: EventDescription.nullable(),
    approvalMode: ApprovalMode,
    cover: PresignedImage.nullable(),
    pendingCount: z.int().min(0),
    pendingPhotographers: z.array(FullName),
  })
  .refine((settings) => settings.pendingPhotographers.length <= settings.pendingCount, {
    path: ['pendingPhotographers'],
    message: 'More pending Photographers than pending requests',
  });
export type EventSettings = z.infer<typeof EventSettings>;

/**
 * GET /events/{eventId}/settings, for the event's Admin only (D-142). The request has no body.
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
export const GetEventSettingsResponse = z.object({
  settings: EventSettings,
});
export type GetEventSettingsResponse = z.infer<typeof GetEventSettingsResponse>;

/**
 * PATCH /events/{eventId}/settings, for the event's Admin only (D-142). It changes the fields the
 * body carries and leaves the rest as they are, in one `update_event_settings` call. The body is
 * `UpdateEventSettingsResponse`.
 *
 * - A body with no field is a 400 `invalid_request`. So is one with any other field, because the
 *   object is strict: a `type`, a cover or an `albumOpen` is refused, never dropped. The type
 *   never changes, the cover has its own two endpoints, and S-31 opens the album.
 * - An empty `description` clears it.
 * - `approvalMode: 'auto'` on a `manual` event admits every pending Photographer, then pending
 *   Guests oldest `requested_at` first until the event holds 150 `active` Guests. The rest stay
 *   `pending`. Switching to `manual` changes no membership (D-142).
 * - The app sends only the fields the Admin changed. It never queues the PATCH, two of the
 *   Admin's phones resolve as last write wins, and an archived event takes one (D-121, D-100).
 * - The API checks the path and the body first, then refuses as GET does. A refused PATCH writes
 *   nothing and admits nobody.
 */
export const UpdateEventSettingsRequest = z
  .strictObject({
    name: EventName.optional(),
    description: EventDescription.optional(),
    approvalMode: ApprovalMode.optional(),
  })
  .refine((request) => Object.values(request).some((value) => value !== undefined), {
    path: [],
    message: 'Nothing to change',
  });
export type UpdateEventSettingsRequest = z.infer<typeof UpdateEventSettingsRequest>;

/**
 * PATCH /events/{eventId}/settings. The settings after the write, so the app replaces its cached
 * settings with them.
 *
 * `admitted` is how many `pending` requests this call made `active`. It is zero unless the call
 * switched a `manual` event to auto. The `pendingCount` beside it is how many the guest cap left
 * waiting, which the form shows.
 */
export const UpdateEventSettingsResponse = z.object({
  settings: EventSettings,
  admitted: z.int().min(0),
});
export type UpdateEventSettingsResponse = z.infer<typeof UpdateEventSettingsResponse>;
