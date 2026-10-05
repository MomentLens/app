import { describe, expect, it } from '@jest/globals';
import { mediaSections, tileStatus } from '@/features/my-media/sections';
import type { QueueItem } from '@/features/upload-queue/types';

const schedule = [
  { id: 'old', name: 'Mehndi', startsAt: '2026-10-03T12:00:00Z', endsAt: '2026-10-03T14:00:00Z' },
  { id: 'live', name: 'Nikah', startsAt: '2026-10-05T12:00:00Z', endsAt: '2026-10-05T14:00:00Z' },
  {
    id: 'future',
    name: 'Walima',
    startsAt: '2026-10-06T12:00:00Z',
    endsAt: '2026-10-06T14:00:00Z',
  },
];
const now = new Date('2026-10-05T13:00:00Z');
const item = (subEventId: string) =>
  ({ id: subEventId, subEventId, state: 'queued', createdAt: 1 }) as QueueItem;

describe('My Media sections', () => {
  it('omits an Upcoming sub-event with no items', () => {
    expect(mediaSections(schedule, [], now).map((s) => s.key)).toEqual(['live', 'old']);
  });
  it('keeps a future section holding items after a schedule edit', () => {
    const sections = mediaSections(schedule, [item('future')], now);
    expect(sections[0]).toMatchObject({ key: 'future', number: 3, canAdd: false });
  });
  it('puts items with a deleted sub-event in the last section with Delete only', () => {
    const sections = mediaSections(schedule, [item('removed')], now);
    expect(sections[sections.length - 1]).toMatchObject({
      key: 'removed',
      name: 'Removed sub-event',
      canAdd: false,
    });
  });
  it('uses schedule order for numerals while displaying newest first', () => {
    expect(mediaSections(schedule, [], now).map((s) => s.number)).toEqual([2, 1]);
  });
  it('shows the reason instead of a badge for a stopped item', () => {
    expect(tileStatus({ ...item('live'), state: 'stopped', stoppedReason: 'event_full' })).toEqual({
      kind: 'reason',
      label: 'This event is full',
    });
    expect(tileStatus({ ...item('live'), state: 'uploaded' }).kind).toBe('spinner');
    expect(tileStatus({ ...item('live'), state: 'published' }).kind).toBe('check');
  });
});
