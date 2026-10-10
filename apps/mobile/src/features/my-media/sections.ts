import type { SubEvent } from '@momentlens/shared-types';
import type { QueueItem, StoppedReason } from '@/features/upload-queue/types';
import type { CaptureDraft } from '@/features/capture/capture-store';

export type MyMediaItem = QueueItem | CaptureDraft;

type SectionEvent = Pick<SubEvent, 'id' | 'name' | 'startsAt' | 'endsAt'>;
export interface MediaSection {
  key: string;
  name: string;
  number: number | null;
  subEvent: SectionEvent | null;
  items: MyMediaItem[];
  canAdd: boolean;
}
export function mediaSections(
  schedule: readonly SectionEvent[],
  rows: readonly MyMediaItem[],
  now: Date,
): MediaSection[] {
  const byId = new Map<string, MyMediaItem[]>();
  for (const item of rows) {
    const list = byId.get(item.subEventId);
    if (list) list.push(item);
    else byId.set(item.subEventId, [item]);
  }
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
export function tileStatus(item: MyMediaItem): {
  kind: 'clock' | 'spinner' | 'check' | 'phone' | 'reason';
  label: string;
} {
  switch (item.state) {
    case 'capture_draft':
      return {
        kind: 'reason',
        label:
          item.galleryState === 'saving'
            ? 'Saving to gallery'
            : item.galleryState === 'saved'
              ? 'Ready to queue. Tap to retry.'
              : item.galleryState === 'uncertain'
                ? 'Gallery save interrupted. Tap to retry.'
                : 'Gallery save needed. Tap to retry.',
      };
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
// Delete removes only the phone's copy of a photo the queue has not sent (D-145). An uploading
// photo may already be finished on the server, so deleting it would hide a photo that still
// publishes, and Local Only belongs to S-30.
export function canDeleteLocally(item: MyMediaItem, removed: boolean): boolean {
  if (item.state === 'capture_draft') return item.galleryState !== 'saving';
  if (item.state === 'uploading' || item.state === 'local_only') return false;
  return removed || (item.state !== 'uploaded' && item.state !== 'published');
}
export type MediaListItem =
  | { type: 'top'; key: 'top' }
  | { type: 'notice'; key: 'notice' }
  | { type: 'header'; key: string; section: MediaSection }
  | { type: 'photos'; key: string; items: MyMediaItem[]; removed: boolean }
  | { type: 'empty'; key: string };
// The title, banners and lines above the sections are the list's first row, and the loading,
// error or empty notice stands in for the sections. FlashList 2.3 places sticky headers by an
// offset that starts at its first row, so with a ListHeaderComponent above that row the first
// section header stuck over the title before anything scrolled.
export function mediaRows(sections: readonly MediaSection[] | null): MediaListItem[] {
  const rows = sections ? mediaListItems(sections) : [];
  return [
    { type: 'top', key: 'top' },
    ...(rows.length ? rows : [{ type: 'notice' as const, key: 'notice' as const }]),
  ];
}
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
