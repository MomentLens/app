import { describe, expect, it } from '@jest/globals';
import type { EventSummary } from '@momentlens/shared-types';

import { groupByTiming, nextTimingChange } from '@/features/events/list';

const NOW = new Date('2026-10-10T12:00:00.000Z');

let serial = 0;
function event(startsAt: string, endsAt: string, extra: Partial<EventSummary> = {}): EventSummary {
  serial += 1;
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    name: `Event ${serial}`,
    type: 'wedding',
    role: 'guest',
    cover: null,
    startsAt,
    endsAt,
    archivedAt: null,
    ...extra,
  };
}

describe('groupByTiming', () => {
  it('puts each event in the tab eventTiming gives it, an archived one in Past', () => {
    const upcoming = event('2026-10-11T10:00:00.000Z', '2026-10-11T14:00:00.000Z');
    const active = event('2026-10-10T10:00:00.000Z', '2026-10-12T14:00:00.000Z');
    const past = event('2026-10-01T10:00:00.000Z', '2026-10-01T14:00:00.000Z');
    const archivedButRunning = event('2026-10-10T10:00:00.000Z', '2026-10-12T14:00:00.000Z', {
      archivedAt: '2026-10-10T11:00:00.000Z',
    });

    const groups = groupByTiming([upcoming, active, past, archivedButRunning], NOW);

    expect(groups.active).toEqual([active]);
    expect(groups.upcoming).toEqual([upcoming]);
    // Past sorts by end, latest first, and the archived event's span ends after the other's.
    expect(groups.past).toEqual([archivedButRunning, past]);
  });

  it('sorts Active and Upcoming by start, soonest first, and Past by end, latest first', () => {
    const laterUpcoming = event('2026-12-01T10:00:00.000Z', '2026-12-01T14:00:00.000Z');
    const soonUpcoming = event('2026-10-20T10:00:00.000Z', '2026-10-20T14:00:00.000Z');
    const olderActive = event('2026-10-09T10:00:00.000Z', '2026-10-11T14:00:00.000Z');
    const newerActive = event('2026-10-10T08:00:00.000Z', '2026-10-10T20:00:00.000Z');
    const longAgo = event('2026-01-01T10:00:00.000Z', '2026-01-01T14:00:00.000Z');
    const recent = event('2026-10-05T10:00:00.000Z', '2026-10-05T14:00:00.000Z');

    const groups = groupByTiming(
      [laterUpcoming, newerActive, longAgo, soonUpcoming, recent, olderActive],
      NOW,
    );

    expect(groups.upcoming).toEqual([soonUpcoming, laterUpcoming]);
    expect(groups.active).toEqual([olderActive, newerActive]);
    expect(groups.past).toEqual([recent, longAgo]);
  });

  it('keeps an event Active in a gap between its sub-events, since only the span counts', () => {
    // The span runs over two days with nothing scheduled overnight; NOW sits in between.
    const withGap = event('2026-10-09T15:00:00.000Z', '2026-10-11T15:00:00.000Z');
    expect(groupByTiming([withGap], NOW).active).toEqual([withGap]);
  });

  it('breaks a tie on the sort time by name, so the order never flickers between fetches', () => {
    const b = event('2026-10-20T10:00:00.000Z', '2026-10-20T14:00:00.000Z', { name: 'Walima' });
    const a = event('2026-10-20T10:00:00.000Z', '2026-10-20T14:00:00.000Z', { name: 'Mehndi' });
    expect(groupByTiming([b, a], NOW).upcoming).toEqual([a, b]);
  });

  it('returns three empty tabs for no events', () => {
    expect(groupByTiming([], NOW)).toEqual({ active: [], upcoming: [], past: [] });
  });
});

describe('nextTimingChange', () => {
  it('is the earliest start or end still ahead, the moment an event changes tab', () => {
    const upcoming = event('2026-10-11T10:00:00.000Z', '2026-10-11T14:00:00.000Z');
    const active = event('2026-10-10T10:00:00.000Z', '2026-10-10T18:00:00.000Z');

    expect(nextTimingChange([upcoming, active], NOW)).toEqual(new Date('2026-10-10T18:00:00.000Z'));
  });

  it('ignores archived events, which stay in Past whatever their span says', () => {
    const archived = event('2026-10-11T10:00:00.000Z', '2026-10-11T14:00:00.000Z', {
      archivedAt: '2026-10-09T10:00:00.000Z',
    });
    expect(nextTimingChange([archived], NOW)).toBeNull();
  });

  it('is null when every event is already in the past', () => {
    const past = event('2026-10-01T10:00:00.000Z', '2026-10-01T14:00:00.000Z');
    expect(nextTimingChange([past], NOW)).toBeNull();
  });

  it('does not return a boundary equal to now, which has already happened', () => {
    const endsNow = event('2026-10-10T10:00:00.000Z', NOW.toISOString());
    expect(nextTimingChange([endsNow], NOW)).toBeNull();
  });
});
