import { describe, expect, it } from '@jest/globals';
import type { SubEvent } from '@momentlens/shared-types';

const subEvents: SubEvent[] = [
  {
    id: 'sub-1',
    name: 'Dholki',
    startsAt: '2026-10-01T14:00:00.000Z',
    endsAt: '2026-10-01T18:00:00.000Z',
    description: null,
    verificationRadiusM: 200,
    venue: { id: 'v1', name: 'Residence DHA', lat: 31.5, lng: 74.3 },
  },
  {
    id: 'sub-2',
    name: 'Mayun',
    startsAt: '2026-10-02T14:00:00.000Z',
    endsAt: '2026-10-02T18:00:00.000Z',
    description: null,
    verificationRadiusM: 200,
    venue: { id: 'v1', name: 'Residence DHA', lat: 31.5, lng: 74.3 },
  },
];

function isPreEvent(subEventsList: readonly SubEvent[], now: Date): boolean {
  if (subEventsList.length === 0) return false;
  const firstStart = Date.parse(subEventsList[0]!.startsAt);
  return now.getTime() < firstStart;
}

describe('Album pre-event state vs grid timing (D-138, D-148)', () => {
  it('shows pre-event state until the first sub-event starts', () => {
    // 1 hour before first sub-event
    const beforeFirst = new Date('2026-10-01T13:00:00.000Z');
    expect(isPreEvent(subEvents, beforeFirst)).toBe(true);

    // Exact start of first sub-event
    const atFirst = new Date('2026-10-01T14:00:00.000Z');
    expect(isPreEvent(subEvents, atFirst)).toBe(false);

    // During event
    const during = new Date('2026-10-01T15:00:00.000Z');
    expect(isPreEvent(subEvents, during)).toBe(false);
  });
});
