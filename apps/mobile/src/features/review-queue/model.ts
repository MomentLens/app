import type {
  FlaggedPhoto,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsResponse,
  MembershipRole,
  ReviewBlurRegion,
  ReviewBlurRegionMedia,
} from '@momentlens/shared-types';
import type { InfiniteData } from '@tanstack/react-query';

import { formatDay, formatTime } from '@/features/events/format';

// The Review Queue's decisions with no React in them, so tests reach them directly (spec §2.5.7,
// D-181).

// Realtime invalidates this prefix on any `media` change in the event, which refetches both lists
// and so signs a regenerated photo again under its new `variant_version` (root invariant 2).
export function reviewQueueKey(eventId: string) {
  return ['review-queue', eventId] as const;
}

export function flaggedPhotosQueryKey(eventId: string) {
  return ['review-queue', eventId, 'flags'] as const;
}

export function reviewBlurRegionsQueryKey(eventId: string) {
  return ['review-queue', eventId, 'blur-regions'] as const;
}

// Only the Admin reviews. A Guest or Photographer would be refused with 403 wrong_role, so the
// lists never ask for them.
export function canReview(role: MembershipRole | undefined): boolean {
  return role === 'admin';
}

export type FlagPages = InfiniteData<ListFlaggedPhotosResponse>;
export type RegionPages = InfiniteData<ListReviewBlurRegionsResponse>;

// --- Loaded lists ---------------------------------------------------------------------------

// The loaded flagged photos in the API's order, each once. A photo flagged again while pages were
// loading moves up, so a refetch can leave it on an earlier page and its old place on a later
// one. The first copy is the newer one.
export function flaggedPhotos(data: FlagPages | undefined): FlaggedPhoto[] {
  const seen = new Set<string>();
  const list: FlaggedPhoto[] = [];
  for (const entry of data?.pages.flatMap((page) => page.photos) ?? []) {
    if (seen.has(entry.media.id)) continue;
    seen.add(entry.media.id);
    list.push(entry);
  }
  return list;
}

export function reviewBlurRegions(data: RegionPages | undefined): ReviewBlurRegion[] {
  const seen = new Set<string>();
  const list: ReviewBlurRegion[] = [];
  for (const entry of data?.pages.flatMap((page) => page.regions) ?? []) {
    if (seen.has(entry.region.id)) continue;
    seen.add(entry.region.id);
    list.push(entry);
  }
  return list;
}

// Each photo once, for the thumbnail batches. Several open regions can sit on one photo, and the
// serving endpoint signs ids, not regions.
export function uniqueMedia(media: readonly ReviewBlurRegionMedia[]): ReviewBlurRegionMedia[] {
  const byId = new Map<string, ReviewBlurRegionMedia>();
  for (const item of media) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

// The total the API counted, which every page carries. Zero before the first page loads.
export function openCount(data: { pages: { openCount: number }[] } | undefined): number {
  return data?.pages[0]?.openCount ?? 0;
}

// --- Dropping an item -----------------------------------------------------------------------

// The pages with every entry `drop` matches taken out, and each page's count lowered by how many
// went, so the segment's count follows at once rather than after the refetch that follows.
function dropFrom<P extends { openCount: number }, T>(
  data: InfiniteData<P> | undefined,
  entries: (page: P) => T[],
  replace: (page: P, kept: T[]) => P,
  drop: (entry: T) => boolean,
  unique: (entry: T) => string,
): InfiniteData<P> | undefined {
  if (!data) return data;
  const gone = new Set<string>();
  for (const page of data.pages)
    for (const entry of entries(page)) if (drop(entry)) gone.add(unique(entry));
  if (gone.size === 0) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...replace(
        page,
        entries(page).filter((entry) => !drop(entry)),
      ),
      openCount: Math.max(0, page.openCount - gone.size),
    })),
  };
}

export function withoutFlaggedPhoto(data: FlagPages | undefined, mediaId: string) {
  return dropFrom(
    data,
    (page) => page.photos,
    (page, photos) => ({ ...page, photos }),
    (entry) => entry.media.id === mediaId,
    (entry) => entry.media.id,
  );
}

export function withoutRegion(data: RegionPages | undefined, regionId: string) {
  return dropFrom(
    data,
    (page) => page.regions,
    (page, regions) => ({ ...page, regions }),
    (entry) => entry.region.id === regionId,
    (entry) => entry.region.id,
  );
}

// A deleted photo takes its open regions with it.
export function withoutRegionsOnPhoto(data: RegionPages | undefined, mediaId: string) {
  return dropFrom(
    data,
    (page) => page.regions,
    (page, regions) => ({ ...page, regions }),
    (entry) => entry.media.id === mediaId,
    (entry) => entry.region.id,
  );
}

// --- Text -----------------------------------------------------------------------------------

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// "11:58 AM" today, "Sat, Oct 3 · 11:58 AM" on another day, since an event runs over several.
export function whenText(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  return sameDay(date, now) ? formatTime(date) : `${formatDay(date)} · ${formatTime(date)}`;
}

// A flagged photo's second line, as design 25 draws it. The count shows only when more than one
// Guest flagged it, and no flagger is ever named (D-181).
export function flagSummary(
  count: number,
  latestFlaggedAt: string,
  now: Date = new Date(),
): string {
  const who = count > 1 ? `Flagged by ${count} guests` : 'Flagged by a guest';
  return `${who} · ${whenText(latestFlaggedAt, now)}`;
}

// The moderation viewer's title, in each platform's case (D-124).
export function flagTitle(count: number, ios: boolean): string {
  const noun = ios ? 'Guests' : 'guests';
  if (count > 1) return `Flagged by ${count} ${noun}`;
  return ios ? 'Flagged by a Guest' : 'Flagged by a guest';
}
