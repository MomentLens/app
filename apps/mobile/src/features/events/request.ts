import { CreateEventRequest } from '@momentlens/shared-types';

import type { DraftSubEvent, DraftVenue, EventDraft } from '@/features/events/draft';

// Sub-events by start, then end, then name: the order step 2 lists them in and the order they are
// sent in (spec §4.3). A new array; the draft keeps the order they were added in.
export function sortSubEvents<T extends Pick<DraftSubEvent, 'startsAt' | 'endsAt' | 'name'>>(
  subEvents: readonly T[],
): T[] {
  return subEvents
    .slice()
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() ||
        a.endsAt.getTime() - b.endsAt.getTime() ||
        a.name.localeCompare(b.name),
    );
}

// Each venue the sub-events use, once, in the order the sorted sub-events first use it. A venue
// is only ever held by a sub-event, so one that no sub-event uses any more is not here, and the
// request never carries the unused venue the API refuses (D-111).
export function draftVenues(subEvents: readonly DraftSubEvent[]): DraftVenue[] {
  const byKey = new Map<string, DraftVenue>();
  for (const subEvent of sortSubEvents(subEvents)) {
    if (!byKey.has(subEvent.venue.key)) {
      byKey.set(subEvent.venue.key, subEvent.venue);
    }
  }
  return [...byKey.values()];
}

// The POST /events body for a draft, parsed with the shared schema, so the wizard sends only what
// the API would accept and a draft that breaks a limit fails here with the same rules (D-110).
export function buildCreateEventRequest(draft: EventDraft) {
  const subEvents = sortSubEvents(draft.subEvents);
  const venues = draftVenues(subEvents);
  const indexOf = new Map(venues.map((venue, index) => [venue.key, index]));
  const description = draft.description.trim();

  return CreateEventRequest.safeParse({
    requestId: draft.requestId,
    name: draft.name,
    type: draft.type,
    ...(description === '' ? {} : { description }),
    approvalMode: draft.approvalRequired ? 'manual' : 'auto',
    venues: venues.map(({ name, lat, lng }) => ({ name, lat, lng })),
    subEvents: subEvents.map((subEvent) => ({
      name: subEvent.name,
      startsAt: subEvent.startsAt.toISOString(),
      endsAt: subEvent.endsAt.toISOString(),
      venueIndex: indexOf.get(subEvent.venue.key),
      verificationRadiusM: subEvent.radiusM,
    })),
  });
}
