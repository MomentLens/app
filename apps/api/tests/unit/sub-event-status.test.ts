// subEventStatus and currentSubEvent from packages/shared-types (spec §4.3, D-88, D-121). The
// capture button and the API's QR check both call currentSubEvent, so they pick the same
// sub-event. The shared package has no test runner, so its tests live here.
import { describe, expect, it } from '@jest/globals';

import { currentSubEvent, subEventStatus } from '@momentlens/shared-types';

function at(iso: string): Date {
  return new Date(iso);
}

const mehndi = {
  id: '30000000-0000-4000-8000-000000000000',
  startsAt: '2026-12-10T14:00:00.000Z',
  endsAt: '2026-12-10T18:00:00.000Z',
};

describe('subEventStatus', () => {
  it('is upcoming before the start', () => {
    expect(subEventStatus(mehndi, at('2026-12-10T13:59:59.999Z'))).toBe('upcoming');
  });

  it('is in progress from the start, which is inside', () => {
    expect(subEventStatus(mehndi, at('2026-12-10T14:00:00.000Z'))).toBe('in_progress');
  });

  it('is in progress up to the last millisecond before the end', () => {
    expect(subEventStatus(mehndi, at('2026-12-10T17:59:59.999Z'))).toBe('in_progress');
  });

  it('is completed from the end, which is outside', () => {
    expect(subEventStatus(mehndi, at('2026-12-10T18:00:00.000Z'))).toBe('completed');
    expect(subEventStatus(mehndi, at('2027-01-01T00:00:00.000Z'))).toBe('completed');
  });

  it('compares instants, so the offset a time was written in changes nothing', () => {
    // 19:00 in Karachi (UTC+5) is 14:00 UTC, the start.
    expect(subEventStatus(mehndi, at('2026-12-10T19:00:00.000+05:00'))).toBe('in_progress');
    expect(subEventStatus(mehndi, at('2026-12-10T18:59:59.999+05:00'))).toBe('upcoming');
  });
});

describe('currentSubEvent', () => {
  // A dholki the night before, then a mehndi that a late-night dance overlaps.
  const dholki = {
    id: '10000000-0000-4000-8000-000000000000',
    startsAt: '2026-12-09T15:00:00.000Z',
    endsAt: '2026-12-09T19:00:00.000Z',
  };
  const dance = {
    id: '20000000-0000-4000-8000-000000000000',
    startsAt: '2026-12-10T16:00:00.000Z',
    endsAt: '2026-12-10T21:00:00.000Z',
  };
  const schedule = [dholki, mehndi, dance];

  it('is null for an empty schedule', () => {
    expect(currentSubEvent([], at('2026-12-10T15:00:00.000Z'))).toBeNull();
  });

  it('is null before the first start, in a gap and after the last end', () => {
    expect(currentSubEvent(schedule, at('2026-12-09T14:59:59.999Z'))).toBeNull();
    expect(currentSubEvent(schedule, at('2026-12-09T19:00:00.000Z'))).toBeNull();
    expect(currentSubEvent(schedule, at('2026-12-10T13:59:59.999Z'))).toBeNull();
    expect(currentSubEvent(schedule, at('2026-12-10T21:00:00.000Z'))).toBeNull();
  });

  it('is the one in progress when only one is', () => {
    expect(currentSubEvent(schedule, at('2026-12-09T15:00:00.000Z'))).toBe(dholki);
    expect(currentSubEvent(schedule, at('2026-12-10T15:59:59.999Z'))).toBe(mehndi);
  });

  it('is the most recently started of two that overlap, whatever the order passed', () => {
    const during = at('2026-12-10T17:00:00.000Z');
    expect(currentSubEvent(schedule, during)).toBe(dance);
    expect(currentSubEvent([dance, mehndi], during)).toBe(dance);
  });

  it('hands back the earlier one once the later one has not started yet or has ended', () => {
    const longer = { ...mehndi, endsAt: '2026-12-10T22:00:00.000Z' };
    expect(currentSubEvent([longer, dance], at('2026-12-10T15:00:00.000Z'))).toBe(longer);
    expect(currentSubEvent([longer, dance], at('2026-12-10T21:30:00.000Z'))).toBe(longer);
  });

  it('breaks a tie on the start by the one that ends first, whatever the order passed', () => {
    const short = { id: 'b0000000-0000-4000-8000-000000000000', ...times('14:00', '15:00') };
    const long = { id: 'a0000000-0000-4000-8000-000000000000', ...times('14:00', '18:00') };
    const during = at('2026-12-10T14:30:00.000Z');
    expect(currentSubEvent([short, long], during)).toBe(short);
    expect(currentSubEvent([long, short], during)).toBe(short);
    // Once the shorter one has ended, the other is the only one in progress.
    expect(currentSubEvent([short, long], at('2026-12-10T15:00:00.000Z'))).toBe(long);
  });

  it('breaks a tie on both times by the lower id, whatever the order passed', () => {
    const lower = { id: '0a000000-0000-4000-8000-000000000000', ...times('14:00', '18:00') };
    const higher = { id: '0b000000-0000-4000-8000-000000000000', ...times('14:00', '18:00') };
    const during = at('2026-12-10T15:00:00.000Z');
    expect(currentSubEvent([lower, higher], during)).toBe(lower);
    expect(currentSubEvent([higher, lower], during)).toBe(lower);
  });

  it('keeps the fields of what it was passed', () => {
    const withVenue = { ...mehndi, venueId: 'hall' };
    expect(currentSubEvent([withVenue], at('2026-12-10T15:00:00.000Z'))).toBe(withVenue);
  });
});

// Times on 2026-12-10, in UTC.
function times(start: string, end: string) {
  return {
    startsAt: `2026-12-10T${start}:00.000Z`,
    endsAt: `2026-12-10T${end}:00.000Z`,
  };
}
