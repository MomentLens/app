import { describe, expect, it } from '@jest/globals';
import { canDeleteLocally, mediaSections, tileStatus } from '@/features/my-media/sections';
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
  it('keeps the queue order inside a section', () => {
    const rows = ['a', 'b', 'c'].map((id) => ({ ...item('live'), id }));
    expect(mediaSections(schedule, rows, now)[0]!.items.map((row) => row.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('offers local Delete only for a photo the queue has not sent (D-145)', () => {
    const at = (state: QueueItem['state']) => ({ ...item('live'), state });
    expect(canDeleteLocally(at('queued'), false)).toBe(true);
    expect(canDeleteLocally(at('waiting_verification'), false)).toBe(true);
    expect(canDeleteLocally({ ...at('stopped'), stoppedReason: 'event_full' }, false)).toBe(true);
    expect(canDeleteLocally(at('uploading'), false)).toBe(false);
    expect(canDeleteLocally(at('uploading'), true)).toBe(false);
    expect(canDeleteLocally(at('uploaded'), false)).toBe(false);
    expect(canDeleteLocally(at('published'), false)).toBe(false);
    expect(canDeleteLocally(at('local_only'), false)).toBe(false);
    expect(canDeleteLocally(at('queued'), true)).toBe(true);
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
