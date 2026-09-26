import { eventTiming, type EventSummary, type EventTiming } from '@momentlens/shared-types';

export type EventGroups = Record<EventTiming, EventSummary[]>;

function byTime(pick: (event: EventSummary) => string, direction: 1 | -1) {
  return (a: EventSummary, b: EventSummary) =>
    direction * (Date.parse(pick(a)) - Date.parse(pick(b))) || a.name.localeCompare(b.name);
}

// The Events tab's three lists at `now` (spec §2.5.1, D-110). The API promises no order, so each
// tab is sorted here: Active and Upcoming by start, soonest first, and Past by end, latest first.
// A tie falls back to the name, so the order stays put between fetches.
export function groupByTiming(events: readonly EventSummary[], now: Date): EventGroups {
  const groups: EventGroups = { active: [], upcoming: [], past: [] };
  for (const event of events) {
    groups[eventTiming(event, now)].push(event);
  }
  groups.active.sort(byTime((event) => event.startsAt, 1));
  groups.upcoming.sort(byTime((event) => event.startsAt, 1));
  groups.past.sort(byTime((event) => event.endsAt, -1));
  return groups;
}

// The next moment any event moves tab: the earliest start or end after `now`. The Events screen
// sets a timer for it, so an event moves from Upcoming to Active while the screen is open. An
// archived event is Past for good and has no such moment.
export function nextTimingChange(events: readonly EventSummary[], now: Date): Date | null {
  const at = now.getTime();
  let next = Infinity;
  for (const event of events) {
    if (event.archivedAt !== null) continue;
    for (const boundary of [Date.parse(event.startsAt), Date.parse(event.endsAt)]) {
      if (boundary > at && boundary < next) next = boundary;
    }
  }
  return next === Infinity ? null : new Date(next);
}
