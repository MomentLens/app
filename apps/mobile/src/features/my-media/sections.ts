import type { SubEvent } from '@momentlens/shared-types';
import type { QueueItem, StoppedReason } from '@/features/upload-queue/types';

type SectionEvent = Pick<SubEvent, 'id' | 'name' | 'startsAt' | 'endsAt'>;
export interface MediaSection {
  key: string;
  name: string;
  number: number | null;
  subEvent: SectionEvent | null;
  items: QueueItem[];
  canAdd: boolean;
}
export function mediaSections(
  schedule: readonly SectionEvent[],
  rows: readonly QueueItem[],
  now: Date,
): MediaSection[] {
  const byId = new Map<string, QueueItem[]>();
  for (const item of rows) byId.set(item.subEventId, [...(byId.get(item.subEventId) ?? []), item]);
  const sections = schedule
    .flatMap((subEvent, index) => {
      const items = byId.get(subEvent.id) ?? [];
      const started = Date.parse(subEvent.startsAt) <= now.getTime();
      return started || items.length
        ? [
            {
              key: subEvent.id,
              name: subEvent.name,
              number: index + 1,
              subEvent,
              items,
              canAdd: started,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Date.parse(b.subEvent.startsAt) - Date.parse(a.subEvent.startsAt) ||
        b.key.localeCompare(a.key),
    );
  const known = new Set(schedule.map((sub) => sub.id));
  const removed = rows.filter((item) => !known.has(item.subEventId));
  const result: MediaSection[] = sections;
  if (removed.length)
    result.push({
      key: 'removed',
      name: 'Removed sub-event',
      number: null,
      subEvent: null,
      items: removed,
      canAdd: false,
    });
  return result;
}
const REASONS: Record<StoppedReason, string> = {
  event_full: 'This event is full',
  too_many_unfinished: 'Too many unfinished uploads',
  sub_event_missing: 'This sub-event was removed',
  invalid_request: 'This photo could not be uploaded',
  not_uploader: 'This photo belongs to another account',
  not_member: 'Your access was removed',
  not_found: 'This event is no longer available',
};
export function tileStatus(item: QueueItem): {
  kind: 'clock' | 'spinner' | 'check' | 'phone' | 'reason';
  label: string;
} {
  switch (item.state) {
    case 'stopped':
      return { kind: 'reason', label: REASONS[item.stoppedReason ?? 'invalid_request'] };
    case 'uploaded':
      return { kind: 'spinner', label: 'Processing' };
    case 'uploading':
      return { kind: 'spinner', label: 'Uploading' };
    case 'published':
      return { kind: 'check', label: 'Published' };
    case 'local_only':
      return { kind: 'phone', label: 'Local only' };
    case 'waiting_album':
      return { kind: 'clock', label: 'Waiting for the album to open' };
    case 'waiting_verification':
      return { kind: 'clock', label: 'Waiting for check-in' };
    default:
      return { kind: 'clock', label: 'Queued' };
  }
}
export type MediaListItem =
  | { type: 'header'; key: string; section: MediaSection }
  | { type: 'photos'; key: string; items: QueueItem[]; removed: boolean }
  | { type: 'empty'; key: string };
export function mediaListItems(sections: readonly MediaSection[]): MediaListItem[] {
  return sections.flatMap((section) => {
    const list: MediaListItem[] = [{ type: 'header', key: `header/${section.key}`, section }];
    if (!section.items.length) list.push({ type: 'empty', key: `empty/${section.key}` });
    for (let i = 0; i < section.items.length; i += 3) {
      list.push({
        type: 'photos',
        key: `photos/${section.key}/${section.items[i]!.id}`,
        items: section.items.slice(i, i + 3),
        removed: section.subEvent === null,
      });
    }
    return list;
  });
}
