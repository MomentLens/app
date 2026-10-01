import {
  AddSubEventRequest,
  MAX_SUB_EVENTS,
  subEventStatus,
  type ErrorCode,
  type MembershipRole,
  type SubEvent,
  type UpdateSubEventRequest,
  type VenueChoice,
} from '@momentlens/shared-types';

import type { DraftVenue } from '@/features/events/draft';
import { dayKey } from '@/features/events/time';
import type { SubEventValues } from '@/features/events/validation';

// The Schedule's rules, kept out of the screens so each one is tested on its own (spec §2.5.5,
// D-121).

export interface SchedulePermissions {
  // Add, Delay, Edit and Delete. The Admin's alone (spec §2.5.5).
  edit: boolean;
  // "View photos from this session", which opens Home. A Photographer has no Home (spec §4.10).
  viewPhotos: boolean;
}

// One list for every role, gated rather than forked (spec §2.5.5). The API checks the role on
// every write as well, so this only decides what is drawn.
export function schedulePermissions(role: MembershipRole): SchedulePermissions {
  return { edit: role === 'admin', viewPhotos: role !== 'photographer' };
}

// The new times a Delay of `delayMs` sends at `at` (D-121). Before the sub-event starts, its start
// and end move together. From its start on, only the end moves, so a running sub-event never goes
// back to Upcoming and one that ended at its scheduled time reopens (D-88). The start goes back
// exactly as the API sent it, so the PATCH changes nothing else, and absolute times make a retry
// harmless.
export function delayedTimes(
  subEvent: Pick<SubEvent, 'startsAt' | 'endsAt'>,
  delayMs: number,
  at: Date,
): { startsAt: string; endsAt: string } {
  const endsAt = new Date(Date.parse(subEvent.endsAt) + delayMs).toISOString();
  if (subEventStatus(subEvent, at) === 'upcoming') {
    return { startsAt: new Date(Date.parse(subEvent.startsAt) + delayMs).toISOString(), endsAt };
  }
  return { startsAt: subEvent.startsAt, endsAt };
}

// The next moment any sub-event changes status: the earliest start or end after `now`. The Schedule
// sets a timer for it, so a row turns In Progress while the screen is open, with no polling.
export function nextStatusChange(
  subEvents: readonly Pick<SubEvent, 'startsAt' | 'endsAt'>[],
  now: Date,
): Date | null {
  const at = now.getTime();
  let next = Infinity;
  for (const subEvent of subEvents) {
    for (const boundary of [Date.parse(subEvent.startsAt), Date.parse(subEvent.endsAt)]) {
      if (boundary > at && boundary < next) next = boundary;
    }
  }
  return next === Infinity ? null : new Date(next);
}

export interface ScheduleEntry<T> {
  subEvent: T;
  // Its place in the whole schedule, from 1, which the row prints as a numeral.
  number: number;
}

export interface ScheduleDay<T> {
  // The local day the entries start on, YYYY-MM-DD.
  key: string;
  entries: ScheduleEntry<T>[];
}

// The schedule split by the local day each sub-event starts on, in the order the API sent it, which
// is by start, then end, then id (D-121). Sub-events are planned across several days (D-88).
export function scheduleDays<T extends Pick<SubEvent, 'startsAt'>>(
  subEvents: readonly T[],
): ScheduleDay<T>[] {
  const days: ScheduleDay<T>[] = [];
  subEvents.forEach((subEvent, index) => {
    const key = dayKey(new Date(subEvent.startsAt));
    const entry = { subEvent, number: index + 1 };
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) {
      last.entries.push(entry);
    } else {
      days.push({ key, entries: [entry] });
    }
  });
  return days;
}

const NUMERALS: readonly [number, string][] = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

// 1 to 15 in Roman numerals, the Figma frames' mark for a sub-event's place in the schedule.
export function romanNumeral(value: number): string {
  let rest = value;
  let text = '';
  for (const [amount, numeral] of NUMERALS) {
    while (rest >= amount) {
      text += numeral;
      rest -= amount;
    }
  }
  return text;
}

// Each venue the schedule uses, once, in schedule order, as the sub-event form lists them. The key
// is the venue's id, which is how a request tells an existing venue from a new one.
export function scheduleVenues(subEvents: readonly Pick<SubEvent, 'venue'>[]): DraftVenue[] {
  const byId = new Map<string, DraftVenue>();
  for (const { venue } of subEvents) {
    if (!byId.has(venue.id)) {
      byId.set(venue.id, { key: venue.id, name: venue.name, lat: venue.lat, lng: venue.lng });
    }
  }
  return [...byId.values()];
}

// True when no sub-event but `subEventId` uses the venue. Moving that sub-event elsewhere or deleting
// it then deletes the venue, and its printed QR stops working (D-121), so the sheet says so first.
export function venueLeftUnused(
  subEvents: readonly Pick<SubEvent, 'id' | 'venue'>[],
  subEventId: string,
  venueId: string,
): boolean {
  return !subEvents.some((other) => other.id !== subEventId && other.venue.id === venueId);
}

// A venue the event has goes by its id, and one made in the picker by its name and pin, which gives
// it a new QR (D-121). A picker's key is a local uuid and never reaches the API.
function venueChoice(venue: DraftVenue, knownVenueIds: ReadonlySet<string>): VenueChoice {
  if (knownVenueIds.has(venue.key)) {
    return { id: venue.key };
  }
  return { name: venue.name, lat: venue.lat, lng: venue.lng };
}

// The POST body for the Add sheet, parsed with the shared schema so the app sends only what the API
// would accept. `requestId` is made once per sheet, so a retry after a timeout adds nothing twice.
export function addRequest(
  requestId: string,
  form: SubEventValues,
  knownVenueIds: ReadonlySet<string>,
) {
  return AddSubEventRequest.safeParse({
    requestId,
    name: form.name,
    startsAt: form.startsAt.toISOString(),
    endsAt: form.endsAt.toISOString(),
    venue: venueChoice(form.venue, knownVenueIds),
    verificationRadiusM: form.radiusM,
  });
}

// The PATCH body for the Edit sheet: only what changed, or null when nothing did. The times go as a
// pair, as the schema requires. The description has no field in the sheet, so it is never sent.
export function updateRequest(
  original: SubEvent,
  form: SubEventValues,
  knownVenueIds: ReadonlySet<string>,
): UpdateSubEventRequest | null {
  const body: UpdateSubEventRequest = {};
  const name = form.name.trim();
  if (name !== original.name) body.name = name;
  if (
    form.startsAt.getTime() !== Date.parse(original.startsAt) ||
    form.endsAt.getTime() !== Date.parse(original.endsAt)
  ) {
    body.startsAt = form.startsAt.toISOString();
    body.endsAt = form.endsAt.toISOString();
  }
  if (form.venue.key !== original.venue.id) body.venue = venueChoice(form.venue, knownVenueIds);
  if (form.radiusM !== original.verificationRadiusM) body.verificationRadiusM = form.radiusM;
  return Object.keys(body).length === 0 ? null : body;
}

export type ScheduleWrite = 'add' | 'edit' | 'delay' | 'delete';

// What the Admin reads when a write fails. `message` never reaches them (hb §5.3); the switch is on
// `code`, and on the status when this build does not know the code.
export function writeProblem(
  error: { status?: number; code?: ErrorCode },
  write: ScheduleWrite,
): string {
  if (error.status === undefined) {
    return write === 'add'
      ? 'MomentLens could not be reached, so nothing was saved. Check the connection and try again. Trying again will not add it twice.'
      : 'MomentLens could not be reached, so nothing was saved. Check the connection and try again.';
  }
  switch (error.code) {
    case 'too_many_sub_events':
      return `This event already has ${MAX_SUB_EVENTS} sub-events, the most one can have.`;
    case 'event_too_long':
      return 'That makes the event longer than 14 days, from its first start to its last end.';
    case 'last_sub_event':
      return 'An event needs at least one sub-event, so its last one cannot be deleted.';
    case 'sub_event_has_media':
      return 'Photos have been added to this sub-event, so it cannot be deleted. You can still rename it or move it.';
    case 'invalid_request':
      return 'The venue you picked is no longer part of this event. It may have been changed on another phone. Choose the venue again.';
    case 'not_found':
      return write === 'add'
        ? 'This event is no longer available.'
        : 'This sub-event was deleted on another phone.';
    case 'not_member':
    case 'wrong_role':
      return 'You can no longer change this schedule.';
    default:
      break;
  }
  if (error.status === 401) {
    return 'Your sign-in could not be confirmed. Try again.';
  }
  return 'Something went wrong on our side. Try again in a moment.';
}

// "Get Directions" (spec §2.5.5): each platform's own maps app, routed to the venue's pin. Both are
// https links the maps app claims, so neither needs a URL scheme declared in app.json.
export function directionsUrl(os: string, venue: { lat: number; lng: number }): string {
  const point = `${venue.lat},${venue.lng}`;
  if (os === 'ios') {
    return `https://maps.apple.com/?daddr=${point}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${point}`;
}
