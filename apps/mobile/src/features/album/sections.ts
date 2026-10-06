import type { AlbumMediaItem, SubEvent } from '@momentlens/shared-types';

import type { AlbumHeaderItem, AlbumListItem, AlbumPhotoItem } from './types';

// Builds the flattened list for FlashList v2 (hb §16, D-148).
// Sections follow the schedule, oldest sub-event first (D-137), in the order the album's pages
// arrive: by start, then by id (D-148). The schedule itself breaks a tie on start by end, so
// following it here would draw a later page's section above an earlier one's.
// Within each section, photos keep the API's order, newest capture first, then by id (D-147).
// A section gets its header once one of its photos has loaded. Its count can run ahead of the
// pages, so a header drawn from the count alone would sit empty below the loaded photos, and a
// sub-event with no photos gets no section under All or under its own chip (D-148).
// `omitted` holds the ids the serving endpoint left out, whose tiles the app drops (D-148).
export function buildAlbumListItems(
  mediaItems: readonly AlbumMediaItem[],
  subEvents: readonly SubEvent[],
  sectionCounts: Readonly<Record<string, number>>,
  liveSubEventId: string | null,
  omitted: ReadonlySet<string> = new Set(),
): { items: AlbumListItem[]; stickyIndices: number[]; unknownSubEvent: boolean } {
  const photosBySubEvent = new Map<string, AlbumMediaItem[]>();
  for (const item of mediaItems) {
    if (omitted.has(item.id)) continue;
    const list = photosBySubEvent.get(item.subEventId);
    if (list) {
      list.push(item);
    } else {
      photosBySubEvent.set(item.subEventId, [item]);
    }
  }

  // The numeral is the sub-event's place in the schedule as the API sorts it (D-145, D-148).
  const numerals = new Map(subEvents.map((subEvent, index) => [subEvent.id, index + 1]));
  const unknownSubEvent = [...photosBySubEvent.keys()].some((id) => !numerals.has(id));
  const pageOrder = [...subEvents].sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const items: AlbumListItem[] = [];
  const stickyIndices: number[] = [];

  for (const subEvent of pageOrder) {
    const photos = photosBySubEvent.get(subEvent.id);
    if (photos === undefined) continue;

    stickyIndices.push(items.length);
    const headerItem: AlbumHeaderItem = {
      type: 'header',
      key: `header-${subEvent.id}`,
      subEventId: subEvent.id,
      subEvent,
      numeral: numerals.get(subEvent.id)!,
      count: sectionCounts[subEvent.id] ?? photos.length,
      isLive: liveSubEventId === subEvent.id,
    };
    items.push(headerItem);

    for (const photo of photos) {
      const photoItem: AlbumPhotoItem = { type: 'media', key: photo.id, media: photo };
      items.push(photoItem);
    }
  }

  return { items, stickyIndices, unknownSubEvent };
}
