import { describe, expect, it } from '@jest/globals';
import {
  AddSubEventRequest,
  MAX_SUB_EVENTS,
  UpdateSubEventRequest,
  type SubEvent,
} from '@momentlens/shared-types';

import type { DraftVenue } from '@/features/events/draft';
import type { SubEventValues } from '@/features/events/validation';
import {
  addRequest,
  delayedTimes,
  delayShortcuts,
  directionsUrl,
  nextStatusChange,
  romanNumeral,
  scheduleDays,
  schedulePermissions,
  scheduleVenues,
  updateRequest,
  venueLeftUnused,
  writeProblem,
} from '@/features/schedule/schedule';

const HOUR = 60 * 60 * 1000;

const HALL = {
  id: '0a8f8d52-3c1e-4b7a-9f2d-5e6c7b8a9d01',
  name: 'Pearl Hall',
  lat: 31.55,
  lng: 74.35,
};
const LAWN = {
  id: '1b9f8d52-3c1e-4b7a-9f2d-5e6c7b8a9d02',
  name: 'Royal Lawn',
  lat: 31.53,
  lng: 74.34,
};

function subEvent(
  id: string,
  startsAt: string,
  endsAt: string,
  venue = HALL,
  overrides: Partial<SubEvent> = {},
): SubEvent {
  return {
    id,
    name: `Sub-event ${id.slice(0, 4)}`,
    description: null,
    startsAt,
    endsAt,
    verificationRadiusM: 200,
    venue,
    ...overrides,
  };
}

const MEHNDI = subEvent(
  'a1a1a1a1-0000-4000-8000-000000000001',
  '2026-10-03T13:00:00.000Z',
  '2026-10-03T16:00:00.000Z',
);
const NIKKAH = subEvent(
  'b2b2b2b2-0000-4000-8000-000000000002',
  '2026-10-03T17:00:00.000Z',
  '2026-10-03T19:00:00.000Z',
  LAWN,
);
const WALIMA = subEvent(
  'c3c3c3c3-0000-4000-8000-000000000003',
  '2026-10-05T15:00:00.000Z',
  '2026-10-05T19:00:00.000Z',
);

describe('delayShortcuts', () => {
  const all = [WALIMA, MEHNDI, NIKKAH];

  it('puts Delay on the next sub-event before anything has started', () => {
    expect(delayShortcuts(all, new Date('2026-10-03T12:00:00.000Z'))).toEqual({
      live: null,
      next: MEHNDI.id,
    });
  });

  it('puts it on the running one and the one after it', () => {
    expect(delayShortcuts(all, new Date('2026-10-03T14:00:00.000Z'))).toEqual({
      live: MEHNDI.id,
      next: NIKKAH.id,
    });
  });

  it('keeps it on the next one in a gap between sub-events', () => {
    expect(delayShortcuts(all, new Date('2026-10-03T16:30:00.000Z'))).toEqual({
      live: null,
      next: NIKKAH.id,
    });
  });

  it('puts it nowhere once everything has ended', () => {
    expect(delayShortcuts(all, new Date('2026-10-06T00:00:00.000Z'))).toEqual({
      live: null,
      next: null,
    });
  });

  it('breaks a tie on the next start by id', () => {
    const twin = subEvent('00000000-0000-4000-8000-000000000009', NIKKAH.startsAt, NIKKAH.endsAt);
    expect(delayShortcuts([NIKKAH, twin], new Date('2026-10-03T16:30:00.000Z')).next).toBe(twin.id);
  });
});

describe('schedulePermissions', () => {
  it('lets the Admin add, delay, edit and delete, and view photos', () => {
    expect(schedulePermissions('admin')).toEqual({ edit: true, viewPhotos: true });
  });

  it('gives a Guest no Add, Delay, Edit or Delete (spec §2.5.5)', () => {
    expect(schedulePermissions('guest')).toEqual({ edit: false, viewPhotos: true });
  });

  it('gives a Photographer the Schedule read-only and no View photos (spec §4.10)', () => {
    expect(schedulePermissions('photographer')).toEqual({ edit: false, viewPhotos: false });
  });
});

describe('delayedTimes', () => {
  const delay = 30 * 60 * 1000;

  it('moves the start and the end before the sub-event starts (D-121)', () => {
    expect(delayedTimes(NIKKAH, delay, new Date('2026-10-03T16:59:59.999Z'))).toEqual({
      startsAt: '2026-10-03T17:30:00.000Z',
      endsAt: '2026-10-03T19:30:00.000Z',
    });
  });

  it('moves only the end from the start itself, which is inside the sub-event (spec §4.3)', () => {
    expect(delayedTimes(NIKKAH, delay, new Date('2026-10-03T17:00:00.000Z'))).toEqual({
      startsAt: NIKKAH.startsAt,
      endsAt: '2026-10-03T19:30:00.000Z',
    });
  });

  it('moves only the end while it runs, so it never goes back to Upcoming', () => {
    expect(delayedTimes(NIKKAH, delay, new Date('2026-10-03T18:00:00.000Z'))).toEqual({
      startsAt: NIKKAH.startsAt,
      endsAt: '2026-10-03T19:30:00.000Z',
    });
  });

  it('moves only the end once it has ended, which reopens an overrun (D-88)', () => {
    expect(delayedTimes(NIKKAH, delay, new Date('2026-10-03T19:10:00.000Z'))).toEqual({
      startsAt: NIKKAH.startsAt,
      endsAt: '2026-10-03T19:30:00.000Z',
    });
  });

  it('sends the start exactly as the API sent it, so the PATCH changes only the end', () => {
    const body = delayedTimes(NIKKAH, delay, new Date('2026-10-03T18:00:00.000Z'));
    expect(UpdateSubEventRequest.safeParse(body).success).toBe(true);
    expect(body.startsAt).toBe(NIKKAH.startsAt);
  });
});

describe('nextStatusChange', () => {
  const schedule = [MEHNDI, NIKKAH, WALIMA];

  it('is the next start or end after now', () => {
    expect(nextStatusChange(schedule, new Date('2026-10-03T12:00:00.000Z'))).toEqual(
      new Date(MEHNDI.startsAt),
    );
    expect(nextStatusChange(schedule, new Date('2026-10-03T14:00:00.000Z'))).toEqual(
      new Date(MEHNDI.endsAt),
    );
  });

  it('skips a boundary that is now, since the status has already changed there', () => {
    expect(nextStatusChange(schedule, new Date(MEHNDI.endsAt))).toEqual(new Date(NIKKAH.startsAt));
  });

  it('is null once every sub-event has ended', () => {
    expect(nextStatusChange(schedule, new Date('2026-10-06T00:00:00.000Z'))).toBeNull();
  });
});

describe('scheduleDays', () => {
  it('groups by the local day of the start and numbers the sub-events across days', () => {
    const days = scheduleDays([MEHNDI, NIKKAH, WALIMA]);
    expect(
      days.map((day) => day.entries.map((entry) => [entry.number, entry.subEvent.id])),
    ).toEqual([
      [
        [1, MEHNDI.id],
        [2, NIKKAH.id],
      ],
      [[3, WALIMA.id]],
    ]);
  });

  it('keeps the order the API sent', () => {
    const days = scheduleDays([NIKKAH, MEHNDI]);
    expect(days[0]?.entries.map((entry) => entry.subEvent.id)).toEqual([NIKKAH.id, MEHNDI.id]);
  });
});

describe('romanNumeral', () => {
  it('writes 1 to 15, the most sub-events an event has', () => {
    expect([1, 4, 9, 14, MAX_SUB_EVENTS].map(romanNumeral)).toEqual(['I', 'IV', 'IX', 'XIV', 'XV']);
  });
});

describe('scheduleVenues', () => {
  it('lists each venue once, keyed by its id, in schedule order', () => {
    expect(scheduleVenues([MEHNDI, NIKKAH, WALIMA])).toEqual([
      { key: HALL.id, name: HALL.name, lat: HALL.lat, lng: HALL.lng },
      { key: LAWN.id, name: LAWN.name, lat: LAWN.lat, lng: LAWN.lng },
    ]);
  });
});

describe('venueLeftUnused', () => {
  it('is true when no other sub-event uses the venue, so its QR stops working (D-121)', () => {
    expect(venueLeftUnused([MEHNDI, NIKKAH, WALIMA], NIKKAH.id, LAWN.id)).toBe(true);
  });

  it('is false while another sub-event shares the venue', () => {
    expect(venueLeftUnused([MEHNDI, NIKKAH, WALIMA], MEHNDI.id, HALL.id)).toBe(false);
  });
});

const hallVenue: DraftVenue = { key: HALL.id, name: HALL.name, lat: HALL.lat, lng: HALL.lng };
const lawnVenue: DraftVenue = { key: LAWN.id, name: LAWN.name, lat: LAWN.lat, lng: LAWN.lng };
const newVenue: DraftVenue = { key: 'local-key', name: 'Garden Marquee', lat: 31.5, lng: 74.3 };
const known = new Set([HALL.id, LAWN.id]);

function formFor(source: SubEvent, overrides: Partial<SubEventValues> = {}): SubEventValues {
  return {
    name: source.name,
    startsAt: new Date(source.startsAt),
    endsAt: new Date(source.endsAt),
    venue: source.venue.id === HALL.id ? hallVenue : lawnVenue,
    radiusM: source.verificationRadiusM,
    ...overrides,
  };
}

describe('updateRequest', () => {
  it('is null when nothing changed, so Save sends nothing', () => {
    expect(updateRequest(NIKKAH, formFor(NIKKAH), known)).toBeNull();
  });

  it('ignores whitespace the schema would trim anyway', () => {
    expect(updateRequest(NIKKAH, formFor(NIKKAH, { name: ` ${NIKKAH.name} ` }), known)).toBeNull();
  });

  it('sends only the fields that changed', () => {
    expect(updateRequest(NIKKAH, formFor(NIKKAH, { name: 'Baraat', radiusM: 500 }), known)).toEqual(
      { name: 'Baraat', verificationRadiusM: 500 },
    );
  });

  it('sends both times when only one moved, as the schema requires', () => {
    const endsAt = new Date(Date.parse(NIKKAH.endsAt) + HOUR);
    const body = updateRequest(NIKKAH, formFor(NIKKAH, { endsAt }), known);
    expect(body).toEqual({ startsAt: NIKKAH.startsAt, endsAt: endsAt.toISOString() });
    expect(UpdateSubEventRequest.safeParse(body).success).toBe(true);
  });

  it('sends a venue this event has by id', () => {
    expect(updateRequest(NIKKAH, formFor(NIKKAH, { venue: hallVenue }), known)).toEqual({
      venue: { id: HALL.id },
    });
  });

  it('sends a new venue by name and pin, never a local key as an id', () => {
    const body = updateRequest(NIKKAH, formFor(NIKKAH, { venue: newVenue }), known);
    expect(body).toEqual({ venue: { name: 'Garden Marquee', lat: 31.5, lng: 74.3 } });
    expect(UpdateSubEventRequest.safeParse(body).success).toBe(true);
  });
});

describe('addRequest', () => {
  const REQUEST_ID = 'd4d4d4d4-0000-4000-8000-000000000004';

  it('builds a body AddSubEventRequest accepts, with the sheet requestId', () => {
    const result = addRequest(REQUEST_ID, formFor(NIKKAH, { venue: newVenue }), known);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      requestId: REQUEST_ID,
      name: NIKKAH.name,
      startsAt: NIKKAH.startsAt,
      endsAt: NIKKAH.endsAt,
      venue: { name: 'Garden Marquee', lat: 31.5, lng: 74.3 },
      verificationRadiusM: 200,
    });
    expect(AddSubEventRequest.safeParse(result.data).success).toBe(true);
  });

  it('picks an existing venue by id', () => {
    const result = addRequest(REQUEST_ID, formFor(NIKKAH), known);
    expect(result.data?.venue).toEqual({ id: LAWN.id });
  });
});

describe('writeProblem', () => {
  it('says a write that never reached the API was not saved, and an Add retry is safe', () => {
    expect(writeProblem({}, 'add')).toMatch(/could not be reached.*not add it twice/);
    expect(writeProblem({}, 'delay')).toMatch(/could not be reached/);
  });

  it('names each limit and conflict code (hb §5.3)', () => {
    expect(writeProblem({ status: 422, code: 'too_many_sub_events' }, 'add')).toMatch(/15/);
    expect(writeProblem({ status: 422, code: 'event_too_long' }, 'delay')).toMatch(/14 days/);
    expect(writeProblem({ status: 409, code: 'last_sub_event' }, 'delete')).toMatch(
      /at least one sub-event/,
    );
    expect(writeProblem({ status: 409, code: 'sub_event_has_media' }, 'delete')).toMatch(
      /[Pp]hotos/,
    );
  });

  it('says a refused venue may have gone on another phone', () => {
    expect(writeProblem({ status: 400, code: 'invalid_request' }, 'edit')).toMatch(/venue/);
  });

  it('says a sub-event deleted elsewhere is gone', () => {
    expect(writeProblem({ status: 404, code: 'not_found' }, 'edit')).toMatch(/deleted/);
  });

  it('tells a caller who lost the Admin role or the event that they cannot change it', () => {
    expect(writeProblem({ status: 403, code: 'wrong_role' }, 'edit')).toMatch(/no longer/);
    expect(writeProblem({ status: 403, code: 'not_member' }, 'add')).toMatch(/no longer/);
  });

  it('falls back to the status for a code this build does not know', () => {
    expect(writeProblem({ status: 500 }, 'edit')).toMatch(/our side/);
  });
});

describe('directionsUrl', () => {
  it('opens Apple Maps on iOS and Google Maps on Android, to the venue pin', () => {
    expect(directionsUrl('ios', HALL)).toBe('https://maps.apple.com/?daddr=31.55,74.35');
    expect(directionsUrl('android', HALL)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=31.55,74.35',
    );
  });
});
