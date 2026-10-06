import { describe, expect, it } from '@jest/globals';
import type { SubEvent } from '@momentlens/shared-types';

import { countdownText, isPreEvent, nextCountdownChange } from '@/features/album/pre-event';

const subEvents: Pick<SubEvent, 'startsAt'>[] = [
  { startsAt: '2026-10-01T14:00:00.000Z' },
  { startsAt: '2026-10-02T14:00:00.000Z' },
];

// Local times, so the calendar-day counts hold in any zone the tests run in.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

describe('Album pre-event state vs grid timing (D-138, D-148)', () => {
  it('shows pre-event state until the first sub-event starts', () => {
    expect(isPreEvent(subEvents, new Date('2026-10-01T13:00:00.000Z'))).toBe(true);
    expect(isPreEvent(subEvents, new Date('2026-10-01T14:00:00.000Z'))).toBe(false);
    expect(isPreEvent(subEvents, new Date('2026-10-01T15:00:00.000Z'))).toBe(false);
  });

  it('is never pre-event with no schedule', () => {
    expect(isPreEvent([], new Date('2026-10-01T13:00:00.000Z'))).toBe(false);
  });
});

describe('Pre-event countdown', () => {
  const start = local(10, 18);

  it('counts hours on the day itself, however close', () => {
    expect(countdownText(start, local(10, 16))).toBe('Starts in 2 hours');
    expect(countdownText(start, local(10, 17, 30))).toBe('Starts in 1 hour');
    expect(countdownText(start, local(10, 0, 5))).toBe('Starts in 18 hours');
  });

  it('says tomorrow for a start after the next midnight, even a few hours away', () => {
    expect(countdownText(start, local(9, 23))).toBe('Starts tomorrow');
    expect(countdownText(start, local(9, 1))).toBe('Starts tomorrow');
  });

  it('counts calendar days further out', () => {
    expect(countdownText(start, local(8, 20))).toBe('2 days to go');
    expect(countdownText(start, local(3, 9))).toBe('7 days to go');
  });

  it('moves on at local midnight, then as each hour runs out on the day', () => {
    expect(nextCountdownChange(start, local(8, 20))).toEqual(local(9, 0));
    expect(nextCountdownChange(start, local(10, 15, 20))).toEqual(local(10, 16));
    expect(nextCountdownChange(start, local(10, 17, 30))).toEqual(start);
  });
});
