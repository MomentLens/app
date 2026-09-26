import { describe, expect, it } from '@jest/globals';
import { CreateEventRequest, MAX_SUB_EVENTS } from '@momentlens/shared-types';

import type { DraftSubEvent, DraftVenue, EventDraft } from '@/features/events/draft';
import { buildCreateEventRequest, draftVenues, sortSubEvents } from '@/features/events/request';

const REQUEST_ID = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';

const hall: DraftVenue = { key: 'hall', name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 };
const lawn: DraftVenue = { key: 'lawn', name: 'Royal Palm Lawn', lat: 31.5299, lng: 74.3474 };

function subEvent(
  key: string,
  venue: DraftVenue,
  startsAt: string,
  endsAt: string,
  radiusM = 200,
): DraftSubEvent {
  return { key, name: key, venue, startsAt: new Date(startsAt), endsAt: new Date(endsAt), radiusM };
}

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    ownerId: '5f3a4c2e-8b1d-4e6f-9a7c-2d1e0b3f4a5c',
    requestId: REQUEST_ID,
    name: "Ayesha & Omar's Wedding",
    type: 'wedding',
    description: '',
    approvalRequired: false,
    cover: null,
    subEvents: [subEvent('Nikkah', hall, '2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z')],
    ...overrides,
  };
}

function built(input: EventDraft) {
  const result = buildCreateEventRequest(input);
  if (!result.success) {
    throw new Error(`expected a valid request, got ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}

describe('buildCreateEventRequest', () => {
  it('builds a body CreateEventRequest accepts, with the wizard requestId', () => {
    const body = built(draft());
    expect(CreateEventRequest.safeParse(body).success).toBe(true);
    expect(body.requestId).toBe(REQUEST_ID);
    expect(body.subEvents[0]).toEqual({
      name: 'Nikkah',
      startsAt: '2026-10-03T08:00:00.000Z',
      endsAt: '2026-10-03T11:00:00.000Z',
      venueIndex: 0,
      verificationRadiusM: 200,
    });
  });

  it('sends one venue for two sub-events at the same hall, so they share one QR (spec §4.3)', () => {
    const body = built(
      draft({
        subEvents: [
          subEvent('Mehndi', hall, '2026-10-02T14:00:00.000Z', '2026-10-02T18:00:00.000Z'),
          subEvent('Nikkah', hall, '2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z', 500),
        ],
      }),
    );
    expect(body.venues).toEqual([{ name: hall.name, lat: hall.lat, lng: hall.lng }]);
    expect(body.subEvents.map((s) => [s.venueIndex, s.verificationRadiusM])).toEqual([
      [0, 200],
      [0, 500],
    ]);
  });

  it('orders sub-events by start and numbers venues by first use in that order', () => {
    const body = built(
      draft({
        subEvents: [
          subEvent('Walima', lawn, '2026-10-04T14:00:00.000Z', '2026-10-04T18:00:00.000Z'),
          subEvent('Nikkah', hall, '2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z'),
          subEvent('Rukhsati', hall, '2026-10-03T12:00:00.000Z', '2026-10-03T13:00:00.000Z'),
        ],
      }),
    );
    expect(body.subEvents.map((s) => [s.name, s.venueIndex])).toEqual([
      ['Nikkah', 0],
      ['Rukhsati', 0],
      ['Walima', 1],
    ]);
    expect(body.venues.map((v) => v.name)).toEqual([hall.name, lawn.name]);
  });

  it('never sends a venue that no sub-event uses any more, which the API refuses (D-111)', () => {
    // The only sub-event at the hall was moved to the lawn in the sheet.
    const body = built(
      draft({
        subEvents: [
          subEvent('Nikkah', lawn, '2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z'),
        ],
      }),
    );
    expect(body.venues).toEqual([{ name: lawn.name, lat: lawn.lat, lng: lawn.lng }]);
  });

  it('trims the names and leaves out an empty or blank description', () => {
    const blank = built(draft({ name: '  Mehndi Night  ', description: '   ' }));
    expect(blank.name).toBe('Mehndi Night');
    expect(blank).not.toHaveProperty('description');

    const described = built(draft({ description: '  Dinner after the nikkah ' }));
    expect(described.description).toBe('Dinner after the nikkah');
  });

  it('sends manual only when the Approval Mode toggle is on (D-111)', () => {
    expect(built(draft({ approvalRequired: false })).approvalMode).toBe('auto');
    expect(built(draft({ approvalRequired: true })).approvalMode).toBe('manual');
  });

  it('fails rather than sending a draft with no type', () => {
    expect(buildCreateEventRequest(draft({ type: null })).success).toBe(false);
  });

  it('fails for one sub-event past the cap', () => {
    const many = Array.from({ length: MAX_SUB_EVENTS + 1 }, (_, i) =>
      subEvent(`Part ${i}`, hall, '2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z'),
    );
    expect(buildCreateEventRequest(draft({ subEvents: many })).success).toBe(false);
  });

  it('fails for a span over 336 hours', () => {
    const long = [
      subEvent('Dholki', hall, '2026-10-01T08:00:00.000Z', '2026-10-01T11:00:00.000Z'),
      subEvent('Walima', lawn, '2026-10-15T08:00:00.000Z', '2026-10-15T11:00:00.000Z'),
    ];
    expect(buildCreateEventRequest(draft({ subEvents: long })).success).toBe(false);
  });
});

describe('sortSubEvents and draftVenues', () => {
  it('sorts by start, then end, then name, without changing the draft', () => {
    const b = subEvent('B', hall, '2026-10-03T08:00:00.000Z', '2026-10-03T12:00:00.000Z');
    const a = subEvent('A', hall, '2026-10-03T08:00:00.000Z', '2026-10-03T12:00:00.000Z');
    const early = subEvent('Early', lawn, '2026-10-03T07:00:00.000Z', '2026-10-03T09:00:00.000Z');
    const input = [b, a, early];

    expect(sortSubEvents(input)).toEqual([early, a, b]);
    expect(input).toEqual([b, a, early]);
  });

  it('lists each venue the sub-events use once', () => {
    const subEvents = [
      subEvent('Nikkah', hall, '2026-10-03T08:00:00.000Z', '2026-10-03T11:00:00.000Z'),
      subEvent('Walima', lawn, '2026-10-04T08:00:00.000Z', '2026-10-04T11:00:00.000Z'),
      subEvent('Rukhsati', hall, '2026-10-03T12:00:00.000Z', '2026-10-03T13:00:00.000Z'),
    ];
    expect(draftVenues(subEvents)).toEqual([hall, lawn]);
  });
});
