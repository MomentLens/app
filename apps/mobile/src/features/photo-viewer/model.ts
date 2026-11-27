import type {
  AlbumMediaItem,
  ListAlbumResponse,
  MediaDetailResponse,
  MembershipRole,
} from '@momentlens/shared-types';
import type { InfiniteData } from '@tanstack/react-query';

// The single photo view's decisions with no React in them, so tests reach them directly
// (spec §2.5.6, D-179).

// --- The pager's list -----------------------------------------------------------------------

// Where the viewer goes when the photo it shows leaves the list: deleted here or by someone else,
// left out by the serving endpoint, or gone after a refetch. The photo itself if it is still
// there, else the nearest photo after it that is still listed, else the nearest before it. Null
// when none are left, or when the photo was never in the list it had before.
export function nextAnchor(
  previous: readonly string[],
  next: readonly string[],
  currentId: string,
): string | null {
  const present = new Set(next);
  if (present.has(currentId)) return currentId;
  const at = previous.indexOf(currentId);
  if (at === -1) return null;
  for (let i = at + 1; i < previous.length; i += 1) {
    if (present.has(previous[i]!)) return previous[i]!;
  }
  for (let i = at - 1; i >= 0; i -= 1) {
    if (present.has(previous[i]!)) return previous[i]!;
  }
  return null;
}

// The photos the pager mounts and signs: the one shown and one either side (D-179).
export function pagerWindow<T>(items: readonly T[], index: number): { item: T; index: number }[] {
  const window: { item: T; index: number }[] = [];
  for (let i = index - 1; i <= index + 1; i += 1) {
    const item = items[i];
    if (i >= 0 && item !== undefined) window.push({ item, index: i });
  }
  return window;
}

// The next album page loads once the photo shown is within this many of the last loaded one.
export const PREFETCH_WITHIN = 5;

export function shouldLoadMore(index: number, length: number): boolean {
  return index >= 0 && index >= length - PREFETCH_WITHIN;
}

// --- The action bar -------------------------------------------------------------------------

export interface ViewerActions {
  blur: boolean;
  flag: boolean;
  delete: boolean;
}

// Who sees which action (spec §2.5.6, D-130, D-179). Blur a region: any Guest and the Admin.
// Flag: a Guest, on a photo somebody else took; on their own photo Delete takes its place, as
// the design shows (Ukasha, S-22 mobile build). Delete: the uploader and the Admin. A Photographer
// never opens this view (D-118), and gets nothing if one does.
export function viewerActions(role: MembershipRole, isOwnPhoto: boolean): ViewerActions {
  if (role === 'admin') return { blur: true, flag: false, delete: true };
  if (role === 'guest') return { blur: true, flag: !isOwnPhoto, delete: isOwnPhoto };
  return { blur: false, flag: false, delete: false };
}

// --- Blur info (ⓘ) -------------------------------------------------------------------------

export const PRIVACY_BLUR_NOTICE = 'This person has requested privacy.';
export const MANUAL_BLUR_NOTICE = 'Someone at this event blurred this area.';

// The §4.18 transparency notice the ⓘ opens, or null when the file this viewer gets has nothing
// blurred and the icon does not show. It never says which part is which (D-170, D-179).
export function blurNotice(
  detail: Pick<MediaDetailResponse, 'hasPrivacyBlur' | 'hasManualBlur'> | undefined,
): string[] | null {
  if (!detail) return null;
  const lines: string[] = [];
  if (detail.hasPrivacyBlur) lines.push(PRIVACY_BLUR_NOTICE);
  if (detail.hasManualBlur) lines.push(MANUAL_BLUR_NOTICE);
  return lines.length ? lines : null;
}

// --- The album cache after a delete ---------------------------------------------------------

type AlbumData = InfiniteData<ListAlbumResponse> | ListAlbumResponse | undefined;

function withoutPhoto(page: ListAlbumResponse, mediaId: string): ListAlbumResponse {
  return { ...page, media: page.media.filter((item) => item.id !== mediaId) };
}

// A section's count sits on the first page, which may not hold the photo itself, so the count
// drops on whichever page carries it.
function lowerCount(
  page: ListAlbumResponse,
  removed: AlbumMediaItem | undefined,
): ListAlbumResponse {
  if (!removed || !page.sectionCounts) return page;
  return {
    ...page,
    sectionCounts: page.sectionCounts
      .map((section) =>
        section.subEventId === removed.subEventId
          ? { ...section, count: Math.max(0, section.count - 1) }
          : section,
      )
      .filter((section) => section.count > 0),
  };
}

// An album query's data with a deleted photo taken out, and its section's count lowered, so Home
// and the pager drop it at once rather than after the refetch that follows (D-130). Works on
// Home's paged album and on the More sheet's single page alike.
export function removeFromAlbum(data: AlbumData, mediaId: string): AlbumData {
  if (!data) return data;
  if ('pages' in data) {
    const removed = data.pages.flatMap((page) => page.media).find((item) => item.id === mediaId);
    if (!removed) return data;
    return {
      ...data,
      pages: data.pages.map((page) => lowerCount(withoutPhoto(page, mediaId), removed)),
    };
  }
  const removed = data.media.find((item) => item.id === mediaId);
  if (!removed) return data;
  return lowerCount(withoutPhoto(data, mediaId), removed);
}

// --- Zoom ----------------------------------------------------------------------------------

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
// How far below 1x a pinch may go before it springs back (D-179's rubber band).
export const RUBBER_ZOOM = 0.6;

export function clamp(value: number, low: number, high: number): number {
  'worklet';
  return Math.min(Math.max(value, low), high);
}

// How far a photo of `content` length, zoomed by `scale` about the screen's centre, may move along
// one axis before an edge comes away from the screen's edge.
export function maxOffset(content: number, viewport: number, scale: number): number {
  'worklet';
  return Math.max(0, (content * scale - viewport) / 2);
}

// The offset that keeps the point under a pinch's focus (relative to the screen's centre) under it
// as the scale goes from `from` to `to`.
export function zoomAbout(focus: number, offset: number, from: number, to: number): number {
  'worklet';
  if (from === 0) return offset;
  return focus - (focus - offset) * (to / from);
}
