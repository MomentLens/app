import { describe, expect, it } from '@jest/globals';

import {
  dayKeys,
  defaultSubEventTimes,
  fromWheelParts,
  nextFullHour,
  toWheelParts,
} from '@/features/events/time';

// Every date here is built in the phone's own zone, which is the zone the wheels show (D-110).
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('nextFullHour', () => {
  it('rounds up to the next full hour', () => {
    expect(nextFullHour(local(2026, 10, 3, 14, 20))).toEqual(local(2026, 10, 3, 15));
  });

  it('moves on an hour when now is already on the hour', () => {
    expect(nextFullHour(local(2026, 10, 3, 14, 0))).toEqual(local(2026, 10, 3, 15));
  });

  it('crosses midnight', () => {
    expect(nextFullHour(local(2026, 10, 3, 23, 30))).toEqual(local(2026, 10, 4, 0));
  });
});

describe('defaultSubEventTimes', () => {
  it('starts the first sub-event at the next full hour and runs it three hours', () => {
    expect(defaultSubEventTimes([], local(2026, 10, 3, 14, 20))).toEqual({
      startsAt: local(2026, 10, 3, 15),
      endsAt: local(2026, 10, 3, 18),
    });
  });

  it('starts a later sub-event where the latest one ends', () => {
    const existing = [{ endsAt: local(2026, 10, 4, 22) }, { endsAt: local(2026, 10, 3, 18) }];
    expect(defaultSubEventTimes(existing, local(2026, 10, 1, 9))).toEqual({
      startsAt: local(2026, 10, 4, 22),
      endsAt: local(2026, 10, 5, 1),
    });
  });
});

describe('wheel parts', () => {
  it('splits an afternoon time into a 12-hour clock', () => {
    expect(toWheelParts(local(2026, 10, 3, 15, 30))).toEqual({
      day: '2026-10-03',
      hour: 3,
      minute: 30,
      meridiem: 'PM',
    });
  });

  it('shows midnight as 12 AM and noon as 12 PM', () => {
    expect(toWheelParts(local(2026, 10, 3, 0, 0))).toMatchObject({ hour: 12, meridiem: 'AM' });
    expect(toWheelParts(local(2026, 10, 3, 12, 0))).toMatchObject({ hour: 12, meridiem: 'PM' });
  });

  it('floors a minute that is not on a 5-minute step, since the wheel has no such row', () => {
    expect(toWheelParts(local(2026, 10, 3, 9, 7)).minute).toBe(5);
  });

  it('joins the parts back into the same local instant', () => {
    for (const date of [
      local(2026, 10, 3, 0, 0),
      local(2026, 10, 3, 11, 55),
      local(2026, 10, 3, 12, 5),
      local(2026, 12, 31, 23, 45),
    ]) {
      expect(fromWheelParts(toWheelParts(date))).toEqual(date);
    }
  });
});

describe('dayKeys', () => {
  it('lists local days from the given days back to the given days ahead, in order', () => {
    expect(dayKeys(local(2026, 10, 3, 15), 2, 3)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ]);
  });

  it('crosses a month and a year end', () => {
    expect(dayKeys(local(2026, 12, 31), 1, 1)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });

  it('adds a chosen day that falls outside the range, so the wheel can still show it', () => {
    expect(dayKeys(local(2026, 10, 3), 0, 1, local(2026, 9, 1, 10))).toEqual([
      '2026-09-01',
      '2026-10-03',
      '2026-10-04',
    ]);
  });
});
