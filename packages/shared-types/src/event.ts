import { z } from 'zod';

import { PresignedImage } from './image';

/** At most 15 sub-events per event, and at least one (spec §4.17, D-88). */
export const MAX_SUB_EVENTS = 15;

/** The event's span, first sub-event start to last sub-event end, is at most 336 hours (D-110). */
export const MAX_EVENT_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A sub-event's verification radius in metres. Each sub-event has its own and the event has
 * none (spec §4.3, D-111).
 */
export const VERIFICATION_RADIUS_MIN_M = 50;
export const VERIFICATION_RADIUS_MAX_M = 2000;
export const VERIFICATION_RADIUS_DEFAULT_M = 200;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

// Trimmed as `String.prototype.trim` trims, then bounded in code points as Postgres
// `char_length` counts them. `.max()` counts UTF-16 units and would reject an emoji name the
// database accepts (see `FullName`). The API sends `create_event` only values this parsed, so
// the migration's checks bound the length and never trim.
function boundedText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .refine((text) => Array.from(text).length <= max, {
      message: `Too big: expected at most ${max} characters`,
    });
}

/**
 * The name of an event, one of its venues or one of its sub-events: trimmed, then 1 to 80
 * characters (D-110).
 */
export const EventName = boundedText(1, NAME_MAX);
export type EventName = z.infer<typeof EventName>;

/** An event's or a sub-event's description: trimmed, at most 500 characters (D-110). */
export const EventDescription = boundedText(0, DESCRIPTION_MAX);
export type EventDescription = z.infer<typeof EventDescription>;

/**
 * An instant as `Date.prototype.toISOString` prints it: UTC, `Z`, exactly three fraction digits.
 *
 * That is the one string format ECMAScript guarantees `Date.parse` reads, on Hermes as on V8.
 * Postgres prints a `timestamptz` with microseconds and `+00:00`, so the API converts every
 * value with `toISOString` before sending, and its response parse fails loudly if it forgets.
 */
export const Timestamp = z.iso.datetime({ precision: 3 });
export type Timestamp = z.infer<typeof Timestamp>;

export const EventType = z.enum(['wedding', 'engagement', 'other']);
export type EventType = z.infer<typeof EventType>;

/** A member's role in one event. Exactly one `admin` per event, its creator (D-102). */
export const MembershipRole = z.enum(['admin', 'photographer', 'guest']);
export type MembershipRole = z.infer<typeof MembershipRole>;

/**
 * How a join request is handled (spec §4.4). `auto` lets a joiner in at once, `manual` holds them
 * as `pending` until the Admin approves. `auto` is the default, because the approval queue arrives
 * with S-07 and a `manual` event made before it lets nobody in (D-110).
 */
export const ApprovalMode = z.enum(['auto', 'manual']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

/** A venue as the wizard sends it. `venue.qr_secret` is made by `create_event`, never sent. */
export const VenueInput = z.object({
  name: EventName,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type VenueInput = z.infer<typeof VenueInput>;

/**
 * A sub-event as the wizard sends it. `venueIndex` points into the request's `venues`.
 * `verificationRadiusM` is this sub-event's own, and the GPS check for it compares against it
 * (spec §4.5). Two sub-events at one venue may use different radii (D-111).
 */
export const SubEventInput = z.object({
  name: EventName,
  description: EventDescription.optional(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  venueIndex: z.int().min(0),
  verificationRadiusM: z.int().min(VERIFICATION_RADIUS_MIN_M).max(VERIFICATION_RADIUS_MAX_M),
});
export type SubEventInput = z.infer<typeof SubEventInput>;

/**
 * POST /events. Creates the event, its venues, its sub-events and the caller's `admin`
 * membership in one `create_event` call (D-110).
 *
 * - `requestId` is a uuid the app makes once per wizard. A repeat from the same caller returns
 *   the first event and creates nothing, so a retry after a timeout never makes a second event.
 * - The event has no venue of its own (D-111). Every venue must be used by at least one
 *   sub-event, so no unused QR is ever made, and there are at most as many venues as
 *   sub-events. Two sub-events at one hall point at one index and share its QR (spec §4.3).
 * - `approvalMode` is `auto` when the app leaves it out (D-110, D-111).
 * - Every check is on the body, so any breach is a 400 `invalid_request` (D-110). A sub-event
 *   may start in the past, and sub-events may overlap (spec §5.3).
 * - The cover is not here. It is uploaded after the event exists, because its key carries the
 *   event's id (arch §3).
 */
export const CreateEventRequest = z
  .object({
    requestId: z.uuid(),
    name: EventName,
    type: EventType,
    description: EventDescription.optional(),
    approvalMode: ApprovalMode.default('auto'),
    venues: z.array(VenueInput).min(1).max(MAX_SUB_EVENTS),
    subEvents: z.array(SubEventInput).min(1).max(MAX_SUB_EVENTS),
  })
  .superRefine((request, ctx) => {
    const used = new Set<number>();
    let first = Infinity;
    let last = -Infinity;

    request.subEvents.forEach((subEvent, i) => {
      const startsAt = Date.parse(subEvent.startsAt);
      const endsAt = Date.parse(subEvent.endsAt);
      if (endsAt <= startsAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['subEvents', i, 'endsAt'],
          message: 'A sub-event must end after it starts',
        });
      }
      if (subEvent.venueIndex >= request.venues.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['subEvents', i, 'venueIndex'],
          message: 'No venue at this index',
        });
      }
      used.add(subEvent.venueIndex);
      first = Math.min(first, startsAt);
      last = Math.max(last, endsAt);
    });

    if (last - first > MAX_EVENT_SPAN_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['subEvents'],
        message: 'The event runs longer than 14 days',
      });
    }

    request.venues.forEach((_, i) => {
      if (!used.has(i)) {
        ctx.addIssue({
          code: 'custom',
          path: ['venues', i],
          message: 'No sub-event uses this venue',
        });
      }
    });
  });
export type CreateEventRequest = z.infer<typeof CreateEventRequest>;

/**
 * One event in the caller's Events list, and the body of a create.
 *
 * `startsAt` and `endsAt` are the span, computed from the sub-events on every read and never
 * stored (D-88). `role` is the caller's own. `cover` is null until a cover is set, so it is
 * always null in a create's response. Pass the event to `eventTiming` for its tab.
 */
export const EventSummary = z.object({
  id: z.uuid(),
  name: EventName,
  type: EventType,
  role: MembershipRole,
  cover: PresignedImage.nullable(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});
export type EventSummary = z.infer<typeof EventSummary>;

/** POST /events. A 201 when this call created the event, a 200 when `requestId` repeated. */
export const CreateEventResponse = z.object({
  event: EventSummary,
});
export type CreateEventResponse = z.infer<typeof CreateEventResponse>;

/**
 * GET /events. Every event where the caller's membership is `active`, soft-deleted events left
 * out (D-110). A pending, blocked or removed membership lists nothing. No order is promised;
 * the app groups by `eventTiming` and sorts within each tab.
 */
export const ListEventsResponse = z.object({
  events: z.array(EventSummary),
});
export type ListEventsResponse = z.infer<typeof ListEventsResponse>;

/**
 * POST /events/{eventId}/cover-upload, for the event's Admin only. The request has no body.
 *
 * The app PUTs the JPEG to `uploadUrl` with `Content-Type: image/jpeg` within 15 minutes
 * (arch §3), then sends `uploadId` to PUT /events/{eventId}/cover. The API builds the object key
 * from the path's event and `uploadId`, so the app never sees or sends a key (root invariant 12).
 */
export const CreateCoverUploadResponse = z.object({
  uploadId: z.uuid(),
  uploadUrl: z.url({ protocol: /^https$/ }),
});
export type CreateCoverUploadResponse = z.infer<typeof CreateCoverUploadResponse>;

/**
 * PUT /events/{eventId}/cover, for the event's Admin only. The API HEADs the object first and
 * answers 409 `upload_missing` when it is not in R2. A repeat with the same `uploadId` sets the
 * same cover again.
 */
export const SetEventCoverRequest = z.object({
  uploadId: z.uuid(),
});
export type SetEventCoverRequest = z.infer<typeof SetEventCoverRequest>;

/** PUT /events/{eventId}/cover. The new cover, presigned for the caller. */
export const SetEventCoverResponse = z.object({
  cover: PresignedImage,
});
export type SetEventCoverResponse = z.infer<typeof SetEventCoverResponse>;

export type EventTiming = 'upcoming' | 'active' | 'past';

/**
 * Which Events tab an event goes in at `now` (D-110). Upcoming before the span starts, Active
 * from the start until the end, gaps between sub-events included, Past from the end. An
 * archived event is Past whatever its span. The bounds match the sub-event status table in
 * spec §4.3: the start is inside, the end is not.
 */
export function eventTiming(
  event: Pick<EventSummary, 'startsAt' | 'endsAt' | 'archivedAt'>,
  now: Date,
): EventTiming {
  if (event.archivedAt !== null) return 'past';
  const at = now.getTime();
  if (at < Date.parse(event.startsAt)) return 'upcoming';
  if (at < Date.parse(event.endsAt)) return 'active';
  return 'past';
}
