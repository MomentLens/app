import type { AlbumMediaItem, SubEvent } from '@momentlens/shared-types';

import type { AlbumHeaderItem, AlbumListItem, AlbumPhotoItem } from './types';

// Builds the flattened list for FlashList v2 (hb §16, D-148).
// Sections follow the schedule order (oldest sub-event first, D-137).
// Within each section, photos sort newest capture time first, then by id (D-147).
// Under "All", a sub-event with no photos gets no section (D-148).
export function buildAlbumListItems(
  mediaItems: readonly AlbumMediaItem[],
  subEvents: readonly SubEvent[],
  sectionCounts: Readonly<Record<string, number>>,
  liveSubEventId: string | null,
  activeSubEventId?: string,
): { items: AlbumListItem[]; stickyIndices: number[] } {
  // Group photos by sub_event_id, maintaining order within each group
  const photosBySubEvent = new Map<string, AlbumMediaItem[]>();
  for (const item of mediaItems) {
    const list = photosBySubEvent.get(item.subEventId);
    if (list) {
      list.push(item);
    } else {
      photosBySubEvent.set(item.subEventId, [item]);
    }
  }

  // Filter sub-events if an active sub-event chip is selected
  const visibleSubEvents = activeSubEventId
    ? subEvents.filter((sub) => sub.id === activeSubEventId)
    : subEvents;

  const items: AlbumListItem[] = [];
  const stickyIndices: number[] = [];

  visibleSubEvents.forEach((subEvent) => {
    // Sub-event position in the full schedule (1-indexed, D-145, D-148)
    const scheduleIndex = subEvents.findIndex((candidate) => candidate.id === subEvent.id);
    const numeral = scheduleIndex === -1 ? 1 : scheduleIndex + 1;
    const photos = photosBySubEvent.get(subEvent.id) ?? [];
    const count = sectionCounts[subEvent.id] ?? photos.length;

    // A sub-event with no photos gets no section under All (D-148)
    if (!activeSubEventId && count === 0 && photos.length === 0) {
      return;
    }

    // Add header
    const headerIndex = items.length;
    stickyIndices.push(headerIndex);
    const headerItem: AlbumHeaderItem = {
      type: 'header',
      key: `header-${subEvent.id}`,
      subEventId: subEvent.id,
      subEvent,
      numeral,
      count,
      isLive: liveSubEventId === subEvent.id,
    };
    items.push(headerItem);

    // Add photos
    for (const photo of photos) {
      const photoItem: AlbumPhotoItem = {
        type: 'media',
        key: photo.id,
        media: photo,
      };
      items.push(photoItem);
    }
  });

  return { items, stickyIndices };
}
