import { z } from 'zod';

import {
  EventDescription,
  EventName,
  MAX_SUB_EVENTS,
  Timestamp,
  VERIFICATION_RADIUS_MAX_M,
  VERIFICATION_RADIUS_MIN_M,
  VenueInput,
} from './event';

const VerificationRadiusM = z.int().min(VERIFICATION_RADIUS_MIN_M).max(VERIFICATION_RADIUS_MAX_M);

/**
 * A sub-event's venue as the schedule returns it. Sub-event Detail's "Get Directions" opens
 * `lat` and `lng` (spec §2.5.5).
 *
 * It never carries `qr_secret` (D-121). zod drops an unknown key, so a column that leaks into the
 * mapping never reaches the body, and the API tests for it too.
 */
export const SubEventVenue = z.object({
  id: z.uuid(),
  name: EventName,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type SubEventVenue = z.infer<typeof SubEventVenue>;

/**
 * One sub-event in the schedule. Its status is not here, because it is computed on read and
 * never stored (D-88); pass the sub-event to `subEventStatus`.
 *
 * - `description` is null when there is none. The database stores an empty one as null, so the
 *   API never sends an empty string.
 * - `verificationRadiusM` is this sub-event's own, and the GPS check for it compares against it.
 *   Two sub-events at one venue may use different radii (D-111).
 * - Sub-events at one venue carry the same `venue.id` and share its QR (spec §4.3).
 */
export const SubEvent = z.object({
  id: z.uuid(),
  name: EventName,
  description: EventDescription.nullable(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  verificationRadiusM: VerificationRadiusM,
  venue: SubEventVenue,
});
export type SubEvent = z.infer<typeof SubEvent>;

/**
 * GET /events/{eventId}/sub-events, for every active role (D-121). The request has no body. The
 * app persists it as a query of its own and refetches it on foreground and reconnect, as it does
 * the event (D-118).
 *
 * - `subEvents` is the whole schedule, 1 to 15 (spec §4.17), in the order the Schedule lists it:
 *   by `startsAt`, then `endsAt`, then `id`.
 * - A caller whose membership is not `active` gets 403 `not_member`, another event's Admin
 *   included. A soft-deleted or unknown event is 404 `not_found`. Both match GET /events/{eventId}.
 *
 * The Admin's three writes answer with this same body, the schedule after the write, so the app
 * replaces its cached schedule with it. Each refuses a Guest or a Photographer with 403
 * `wrong_role`, and resolves the event the same way as the read: through the path for POST, and
 * through the sub-event's own event for PATCH and DELETE. An unknown sub-event is 404 `not_found`.
 * - POST /events/{eventId}/sub-events takes `AddSubEventRequest`.
 * - PATCH /sub-events/{subEventId} takes `UpdateSubEventRequest`.
 * - DELETE /sub-events/{subEventId} has no body. It answers 409 `last_sub_event` for the event's
 *   only sub-event, and from S-12 on, 409 `sub_event_has_media` for one with photos (D-121).
 */
export const ListSubEventsResponse = z.object({
  subEvents: z.array(SubEvent).min(1).max(MAX_SUB_EVENTS),
});
export type ListSubEventsResponse = z.infer<typeof ListSubEventsResponse>;

/**
 * Where an added or edited sub-event takes place: `{ id }` for a venue this event already has,
 * or `{ name, lat, lng }` for a new one, which gets a new QR (D-121).
 *
 * - Each object is strict, so a body carrying both an `id` and a pin is a 400 rather than a guess
 *   at which one the app meant.
 * - An `id` that is not a venue of this event is a 400 `invalid_request`: another event's venue,
 *   or one that another phone's edit deleted since this phone fetched the schedule.
 * - A venue's name and pin are never edited in place. To fix one, the Admin picks another venue
 *   or a new one for each of its sub-events (D-121).
 */
export const VenueChoice = z.union([
  z.strictObject({ id: z.uuid() }),
  z.strictObject(VenueInput.shape),
]);
export type VenueChoice = z.infer<typeof VenueChoice>;

function endsAfterStart(times: { startsAt: string; endsAt: string }): boolean {
  return Date.parse(times.endsAt) > Date.parse(times.startsAt);
}

/**
 * POST /events/{eventId}/sub-events, for the event's Admin only. A 201 when this call added the
 * sub-event, a 200 when `requestId` repeated. Either way the body is `ListSubEventsResponse`.
 *
 * - `requestId` is a uuid the app makes once per Add sheet. A repeat adds nothing and returns the
 *   schedule, so a retry after a timeout never adds a second sub-event (D-121).
 * - The end must come after the start, a 400 `invalid_request` otherwise.
 * - A 16th sub-event is 422 `too_many_sub_events`. One that takes the event's span past 336 hours
 *   is 422 `event_too_long`, a single sub-event that long included (D-110, D-121).
 * - A start in the past is allowed, sub-events may overlap, and an archived event takes one
 *   (spec §5.3, D-121).
 */
export const AddSubEventRequest = z
  .object({
    requestId: z.uuid(),
    name: EventName,
    description: EventDescription.optional(),
    startsAt: Timestamp,
    endsAt: Timestamp,
    venue: VenueChoice,
    verificationRadiusM: VerificationRadiusM,
  })
  .refine(endsAfterStart, { path: ['endsAt'], message: 'A sub-event must end after it starts' });
export type AddSubEventRequest = z.infer<typeof AddSubEventRequest>;

/**
 * PATCH /sub-events/{subEventId}, for the event's Admin only. It changes the fields the body
 * carries and leaves the rest as they are. The body is `ListSubEventsResponse`.
 *
 * - The times travel as a pair, both or neither, so the body alone shows the end comes after the
 *   start. Anything else is a 400 `invalid_request`, as is a body with no field.
 * - An empty `description` clears it.
 * - The server cannot tell a Delay from an edit. The app turns a Delay into new times (D-121):
 *   before the sub-event starts it sends the start and the end both moved, and once it has
 *   started it sends the start unchanged and the end moved. Absolute times make a retry harmless.
 * - An edit that takes the span past 336 hours is 422 `event_too_long` (D-121).
 * - An edit that leaves a venue with no sub-event deletes that venue in the same transaction, and
 *   its printed QR stops working (D-121).
 * - An edit moves no photo and no verification (D-100). Two of the Admin's phones editing one
 *   sub-event resolve as last write wins (D-121).
 */
export const UpdateSubEventRequest = z
  .object({
    name: EventName.optional(),
    description: EventDescription.optional(),
    startsAt: Timestamp.optional(),
    endsAt: Timestamp.optional(),
    venue: VenueChoice.optional(),
    verificationRadiusM: VerificationRadiusM.optional(),
  })
  .superRefine((request, ctx) => {
    if (Object.values(request).every((value) => value === undefined)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'Nothing to change' });
      return;
    }
    const { startsAt, endsAt } = request;
    if (startsAt === undefined && endsAt === undefined) return;
    if (startsAt === undefined || endsAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [startsAt === undefined ? 'startsAt' : 'endsAt'],
        message: 'A start and an end are sent together',
      });
      return;
    }
    if (!endsAfterStart({ startsAt, endsAt })) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'A sub-event must end after it starts',
      });
    }
  });
export type UpdateSubEventRequest = z.infer<typeof UpdateSubEventRequest>;

/**
 * A sub-event's status at an instant, from the table in spec §4.3. The start is inside and the end
 * is not, as in `eventTiming`.
 */
export type SubEventStatus = 'upcoming' | 'in_progress' | 'completed';

export function subEventStatus(
  subEvent: Pick<SubEvent, 'startsAt' | 'endsAt'>,
  at: Date,
): SubEventStatus {
  const time = at.getTime();
  if (time < Date.parse(subEvent.startsAt)) return 'upcoming';
  if (time < Date.parse(subEvent.endsAt)) return 'in_progress';
  return 'completed';
}

/**
 * The sub-event a photo or a check-in belongs to at `at`, or null when none is In Progress then.
 *
 * Of those In Progress, the most recently started wins (spec §4.3). On a tie the one that ends
 * first wins, then the lower id (D-121). Postgres prints a uuid in lower case, and comparing two
 * such strings orders them as Postgres orders the uuids.
 *
 * The capture button passes every sub-event of the event. The API passes one venue's sub-events
 * for a QR scan and asks at the reading's time (D-85, D-121). Both call this, so they pick the
 * same sub-event.
 */
export function currentSubEvent<T extends Pick<SubEvent, 'id' | 'startsAt' | 'endsAt'>>(
  subEvents: readonly T[],
  at: Date,
): T | null {
  let current: T | null = null;
  for (const subEvent of subEvents) {
    if (subEventStatus(subEvent, at) !== 'in_progress') continue;
    if (current === null || winsOver(subEvent, current)) current = subEvent;
  }
  return current;
}

function winsOver(a: Pick<SubEvent, 'id' | 'startsAt' | 'endsAt'>, b: typeof a): boolean {
  const startA = Date.parse(a.startsAt);
  const startB = Date.parse(b.startsAt);
  if (startA !== startB) return startA > startB;
  const endA = Date.parse(a.endsAt);
  const endB = Date.parse(b.endsAt);
  if (endA !== endB) return endA < endB;
  return a.id < b.id;
}
