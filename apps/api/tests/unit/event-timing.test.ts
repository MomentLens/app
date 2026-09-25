// eventTiming from packages/shared-types, which puts an event in its Events tab (D-110). The app
// and the API share it, and the shared package has no test runner, so its tests live here.
import { describe, expect, it } from '@jest/globals';

import { eventTiming } from '@momentlens/shared-types';

// A two-day wedding with a night between its sub-events: the span runs from the first start to
// the last end, and the gap is inside it.
const event = {
  startsAt: '2026-12-10T14:00:00.000Z',
  endsAt: '2026-12-11T23:00:00.000Z',
  archivedAt: null,
};

function at(iso: string): Date {
  return new Date(iso);
}

describe('eventTiming', () => {
  it('is upcoming before the first sub-event starts', () => {
    expect(eventTiming(event, at('2026-12-10T13:59:59.999Z'))).toBe('upcoming');
  });

  it('is active from the first start, which is inside the span', () => {
    expect(eventTiming(event, at('2026-12-10T14:00:00.000Z'))).toBe('active');
  });

  it('stays active in a gap between sub-events', () => {
    expect(eventTiming(event, at('2026-12-11T03:00:00.000Z'))).toBe('active');
  });

  it('is active up to the last millisecond before the end', () => {
    expect(eventTiming(event, at('2026-12-11T22:59:59.999Z'))).toBe('active');
  });

  it('is past from the last end, which is outside the span', () => {
    expect(eventTiming(event, at('2026-12-11T23:00:00.000Z'))).toBe('past');
    expect(eventTiming(event, at('2027-01-01T00:00:00.000Z'))).toBe('past');
  });

  it.each([
    ['before it starts', '2026-12-01T00:00:00.000Z'],
    ['while it runs', '2026-12-10T18:00:00.000Z'],
    ['after it ends', '2026-12-20T00:00:00.000Z'],
  ])('is past when archived, %s', (_when, now) => {
    const archived = { ...event, archivedAt: '2026-12-05T09:30:00.000Z' };
    expect(eventTiming(archived, at(now))).toBe('past');
  });

  it('compares instants, so the offset a time was written in changes nothing', () => {
    // 19:00 in Karachi (UTC+5) is 14:00 UTC, the first start.
    expect(eventTiming(event, at('2026-12-10T19:00:00.000+05:00'))).toBe('active');
    expect(eventTiming(event, at('2026-12-10T18:59:59.999+05:00'))).toBe('upcoming');
  });
});
