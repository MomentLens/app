import { describe, expect, it } from '@jest/globals';

import { defaultSubEventTimes, nextFullHour } from '@/features/events/time';

// Every date here is built in the phone's own zone, which is the zone the pickers show (D-110).
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
