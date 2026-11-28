import type {
  FlaggedPhoto,
  ListFlaggedPhotosResponse,
  ListReviewBlurRegionsResponse,
  MediaDetailResponse,
} from '@momentlens/shared-types';
import { onlineManager, useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fullImageQuery } from '@/features/album/full-image';
import { blurRegionsQueryKey } from '@/features/blur-regions/use-blur-regions';
import { recheckEvent, retryUnlessRefused, useEvent } from '@/features/event-shell/use-event';
import {
  nextAnchor,
  pagerWindow,
  removeFromAlbum,
  shouldLoadMore,
} from '@/features/photo-viewer/model';
import { mediaDetailQueryKey, type ViewerSlot } from '@/features/photo-viewer/use-photo-viewer';
import {
  ApiError,
  deleteMedia,
  getMediaDetail,
  keepBlurRegion,
  keepPhotoFlags,
  listFlaggedPhotos,
  listReviewBlurRegions,
  removeBlurRegion,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';

import {
  canReview,
  flaggedPhotos,
  flaggedPhotosQueryKey,
  reviewBlurRegionsQueryKey,
  reviewQueueKey,
  withoutFlaggedPhoto,
  withoutRegion,
  withoutRegionsOnPhoto,
  type FlagPages,
  type RegionPages,
} from './model';

// The Review Queue's server state and its four actions (spec §2.5.7, D-181). Both lists live in
// TanStack Query under one prefix, which Realtime invalidates (use-media-realtime.ts). The actions
// need a connection and are never queued: a moderation decision made offline and sent later could
// act on a photo that changed in between.

function refusedOn(eventId: string, error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404))
    recheckEvent(eventId);
}

export function flaggedPhotosQueryOptions(eventId: string) {
  return {
    queryKey: flaggedPhotosQueryKey(eventId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      try {
        return await listFlaggedPhotos(eventId, { cursor: pageParam }, signal);
      } catch (error) {
        refusedOn(eventId, error);
        throw error;
      }
    },
    getNextPageParam: (page: ListFlaggedPhotosResponse) => page.nextCursor ?? undefined,
    retry: retryUnlessRefused,
  };
}

export function reviewBlurRegionsQueryOptions(eventId: string) {
  return {
    queryKey: reviewBlurRegionsQueryKey(eventId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      try {
        return await listReviewBlurRegions(eventId, { cursor: pageParam }, signal);
      } catch (error) {
        refusedOn(eventId, error);
        throw error;
      }
    },
    getNextPageParam: (page: ListReviewBlurRegionsResponse) => page.nextCursor ?? undefined,
    retry: retryUnlessRefused,
  };
}

export function useFlaggedPhotos(eventId: string) {
  const role = useEvent(eventId).data?.event.role;
  return useInfiniteQuery({ ...flaggedPhotosQueryOptions(eventId), enabled: canReview(role) });
}

export function useReviewBlurRegions(eventId: string) {
  const role = useEvent(eventId).data?.event.role;
  return useInfiniteQuery({ ...reviewBlurRegionsQueryOptions(eventId), enabled: canReview(role) });
}

// --- Actions --------------------------------------------------------------------------------

// done: the API took it, or the thing was already gone where gone is the goal (Delete, Remove).
// gone: a Keep found the photo or region gone; it leaves the list.
// refused: a 403; the event refetch decides what the screen shows next.
// failed: no answer or a server error; the item stays and the person can try again.
// offline: nothing was sent.
export type ReviewOutcome = 'done' | 'gone' | 'refused' | 'failed' | 'offline';

function settle(eventId: string, error: unknown): 'gone' | 'refused' | 'failed' {
  refusedOn(eventId, error);
  if (error instanceof ApiError && error.status === 404) return 'gone';
  if (error instanceof ApiError && error.status === 403) return 'refused';
  return 'failed';
}

function dropFlaggedPhoto(eventId: string, mediaId: string) {
  queryClient.setQueryData<FlagPages>(flaggedPhotosQueryKey(eventId), (data) =>
    withoutFlaggedPhoto(data, mediaId),
  );
}

function dropRegion(eventId: string, regionId: string) {
  queryClient.setQueryData<RegionPages>(reviewBlurRegionsQueryKey(eventId), (data) =>
    withoutRegion(data, regionId),
  );
}

// Keep on a flagged photo: every open flag on it becomes kept (D-181). The photo stays published.
export async function keepFlags(eventId: string, mediaId: string): Promise<ReviewOutcome> {
  if (!onlineManager.isOnline()) return 'offline';
  try {
    await keepPhotoFlags(mediaId);
    dropFlaggedPhoto(eventId, mediaId);
    return 'done';
  } catch (error) {
    const outcome = settle(eventId, error);
    if (outcome === 'gone') {
      dropFlaggedPhoto(eventId, mediaId);
      void queryClient.invalidateQueries({ queryKey: reviewQueueKey(eventId) });
    }
    return outcome;
  }
}

// Delete on a flagged photo: S-22's permanent delete (D-130). A 404 means the uploader or another
// device already deleted it, or an earlier try landed and its answer was lost, so it counts as
// done. The photo leaves the queue, its open regions, and Home's album at once.
export async function deleteFlaggedPhoto(eventId: string, mediaId: string): Promise<ReviewOutcome> {
  if (!onlineManager.isOnline()) return 'offline';
  try {
    await deleteMedia(mediaId);
  } catch (error) {
    const outcome = settle(eventId, error);
    if (outcome !== 'gone') return outcome;
  }
  dropFlaggedPhoto(eventId, mediaId);
  queryClient.setQueryData<RegionPages>(reviewBlurRegionsQueryKey(eventId), (data) =>
    withoutRegionsOnPhoto(data, mediaId),
  );
  queryClient.setQueriesData({ queryKey: ['album', eventId] }, (data) =>
    removeFromAlbum(data as Parameters<typeof removeFromAlbum>[0], mediaId),
  );
  void queryClient.invalidateQueries({ queryKey: ['album', eventId] });
  void queryClient.invalidateQueries({ queryKey: ['uploaders', eventId] });
  void queryClient.invalidateQueries({ queryKey: reviewQueueKey(eventId) });
  return 'done';
}

// Keep on a blur region: it leaves the queue and stays on the photo (root invariant 6).
export async function keepRegion(eventId: string, regionId: string): Promise<ReviewOutcome> {
  if (!onlineManager.isOnline()) return 'offline';
  try {
    await keepBlurRegion(regionId);
    dropRegion(eventId, regionId);
    return 'done';
  } catch (error) {
    const outcome = settle(eventId, error);
    if (outcome === 'gone') {
      dropRegion(eventId, regionId);
      void queryClient.invalidateQueries({ queryKey: reviewQueueKey(eventId) });
    }
    return outcome;
  }
}

// Remove on a blur region: S-19's delete, which enqueues a regeneration without it (D-83). A 404
// means it is already gone, so it counts as done (shared-types blur-region.ts).
export async function removeRegion(
  eventId: string,
  regionId: string,
  mediaId: string,
): Promise<ReviewOutcome> {
  if (!onlineManager.isOnline()) return 'offline';
  try {
    const after = await removeBlurRegion(regionId);
    queryClient.setQueryData(blurRegionsQueryKey(mediaId), after);
  } catch (error) {
    const outcome = settle(eventId, error);
    if (outcome !== 'gone') return outcome;
    void queryClient.invalidateQueries({ queryKey: blurRegionsQueryKey(mediaId) });
    void queryClient.invalidateQueries({ queryKey: reviewQueueKey(eventId) });
  }
  dropRegion(eventId, regionId);
  return 'done';
}

// --- The moderation viewer ------------------------------------------------------------------

export type FlagViewerState = 'loading' | 'ready' | 'gone' | 'closed' | 'error';

// The flagged-photo viewer's data (D-181). It pages through the loaded flagged photos in the
// queue's order, anchored on the photo's id as S-22's viewer is, so a Keep or Delete moves it to
// the next photo, and it closes when none are left. Each full image is signed under the album's
// key, which carries `variant_version` (root invariant 2).
export function useFlaggedViewer(eventId: string, openedId: string) {
  const role = useEvent(eventId).data?.event.role;
  const query = useFlaggedPhotos(eventId);
  const list = useMemo(() => flaggedPhotos(query.data), [query.data]);
  const ids = useMemo(() => list.map((entry) => entry.media.id), [list]);

  const [currentId, setCurrentId] = useState(openedId);
  const [lost, setLost] = useState<'gone' | 'closed' | null>(null);
  const shownIds = useRef<readonly string[]>([]);

  useEffect(() => {
    if (!query.isSuccess) return;
    const anchor = nextAnchor(shownIds.current, ids, currentId);
    if (anchor === null) {
      setLost(shownIds.current.length ? 'closed' : 'gone');
      return;
    }
    shownIds.current = ids;
    setLost(null);
    if (anchor !== currentId) setCurrentId(anchor);
  }, [query.isSuccess, ids, currentId]);

  const index = ids.indexOf(currentId);
  const current: FlaggedPhoto | undefined = list[index];

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (shouldLoadMore(index, ids.length) && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [index, ids.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const mounted = useMemo(() => pagerWindow(list, index), [list, index]);
  const images = useQueries({
    queries: mounted.map(({ item }) =>
      fullImageQuery(eventId, item.media.id, item.media.variantVersion),
    ),
  });
  const slots: ViewerSlot[] = mounted.map(({ item, index: at }, i) => ({
    media: item.media,
    index: at,
    image: images[i]?.data,
    imageError: images[i]?.isError ?? false,
  }));
  const retryImage = useCallback(
    (mediaId: string) => {
      void queryClient.invalidateQueries({ queryKey: ['media-images', eventId, 'full', mediaId] });
    },
    [eventId],
  );

  // Whether the file the Admin gets has anything blurred, for the ⓘ notice (D-179).
  const detail = useQuery({
    queryKey: mediaDetailQueryKey(current?.media.id ?? '', current?.media.variantVersion ?? 0),
    queryFn: async ({ signal }): Promise<MediaDetailResponse> => {
      try {
        return await getMediaDetail(current!.media.id, signal);
      } catch (error) {
        refusedOn(eventId, error);
        throw error;
      }
    },
    enabled: current !== undefined && canReview(role),
    retry: retryUnlessRefused,
  });

  let state: FlagViewerState;
  if (lost) state = lost;
  else if (current) state = 'ready';
  else if (query.isError && !query.data) state = 'error';
  else state = 'loading';

  return {
    state,
    role,
    current,
    index,
    count: ids.length,
    slots,
    retryImage,
    retryList: () => void query.refetch(),
    goTo: setCurrentId,
    detail: detail.data,
  };
}
