import type {
  AlbumMediaItem,
  MediaDetailResponse,
  MediaImage,
  SubEvent,
} from '@momentlens/shared-types';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildAlbumListItems } from '@/features/album/sections';
import { useAlbum, type AlbumFilters } from '@/features/album/use-album';
import { fullImageQuery } from '@/features/album/full-image';
import { recheckEvent, retryUnlessRefused, useEvent } from '@/features/event-shell/use-event';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { ApiError, deleteMedia, flagPhoto, getMediaDetail } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

import {
  nextAnchor,
  pagerWindow,
  removeFromAlbum,
  shouldLoadMore,
  viewerActions,
  type ViewerActions,
} from './model';

const EMPTY_SCHEDULE: SubEvent[] = [];
const NO_ACTIONS: ViewerActions = { blur: false, flag: false, delete: false };

export function mediaDetailQueryKey(mediaId: string, variantVersion: number) {
  return ['media-detail', mediaId, variantVersion] as const;
}

export interface ViewerSlot {
  media: AlbumMediaItem;
  index: number;
  // undefined while signing, null when the serving endpoint left the photo out.
  image: MediaImage | null | undefined;
  imageError: boolean;
}

// What happened to the photo the viewer opened on: still loading, shown, or no longer in the album
// (deleted, unpublished, or left out for this viewer). `closed` means the last photo went and the
// screen should close.
export type ViewerState = 'loading' | 'ready' | 'gone' | 'closed' | 'error';

export type ActionResult = 'done' | 'refused' | 'failed';

// The single photo view's data (spec §2.5.6, D-179). The pager pages through exactly what Home's
// grid shows under the same filters: it reads the same album query, so Home's Realtime channel
// refreshes both, and a photo whose `variant_version` moves is signed again under its new key
// (root invariant 2). It is anchored on the photo's id, never its position, so a photo arriving
// or leaving elsewhere in the album does not move the view.
export function usePhotoViewer(eventId: string, openedId: string, filters: AlbumFilters) {
  const client = useQueryClient();
  const userId = useAuthStore((state) => state.userId);
  const role = useEvent(eventId).data?.event.role;
  const album = useAlbum(eventId, filters);
  const schedule = useSubEvents(eventId);
  const subEvents = schedule.data?.subEvents ?? EMPTY_SCHEDULE;

  // Photos the serving endpoint left out of a full-image request. The grid drops them, and so does
  // the pager (D-148).
  const [omitted, setOmitted] = useState<ReadonlySet<string>>(new Set());

  const media = useMemo(
    () => album.data?.pages.flatMap((page) => page.media) ?? [],
    [album.data?.pages],
  );
  // The grid's own order, through the grid's own builder, so a swipe always lands on the tile
  // beside the one before it.
  const list = useMemo(
    () =>
      buildAlbumListItems(media, subEvents, {}, null, omitted).items.flatMap((item) =>
        item.type === 'media' ? [item.media] : [],
      ),
    [media, subEvents, omitted],
  );
  const ids = useMemo(() => list.map((item) => item.id), [list]);

  const [currentId, setCurrentId] = useState(openedId);
  const [lost, setLost] = useState<'gone' | 'closed' | null>(null);
  const shownIds = useRef<readonly string[]>([]);
  const listReady = album.isSuccess && schedule.isSuccess;

  useEffect(() => {
    if (!listReady) return;
    const anchor = nextAnchor(shownIds.current, ids, currentId);
    if (anchor === null) {
      // The photo left with nothing after or before it, or it was never in what loaded.
      setLost(shownIds.current.length ? 'closed' : 'gone');
      return;
    }
    shownIds.current = ids;
    setLost(null);
    if (anchor !== currentId) setCurrentId(anchor);
  }, [listReady, ids, currentId]);

  const index = ids.indexOf(currentId);
  const current: AlbumMediaItem | undefined = list[index];

  // The next album page, before the pager reaches the end of what loaded (D-179).
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = album;
  useEffect(() => {
    if (shouldLoadMore(index, ids.length) && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [index, ids.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // The 3-photo window, signed one photo at a time under the Blur screen's key.
  const mounted = useMemo(() => pagerWindow(list, index), [list, index]);
  // A photo the endpoint leaves out leaves the pager, as its tile leaves the grid (D-148).
  const leaveOut = useCallback((mediaId: string) => {
    setOmitted((before) => (before.has(mediaId) ? before : new Set(before).add(mediaId)));
  }, []);
  const images = useQueries({
    queries: mounted.map(({ item }) => {
      const query = fullImageQuery(eventId, item.id, item.variantVersion);
      return {
        ...query,
        queryFn: async (context: { signal: AbortSignal }) => {
          const image = await query.queryFn(context);
          if (image === null) leaveOut(item.id);
          return image;
        },
      };
    }),
  });
  const slots: ViewerSlot[] = mounted.map(({ item, index: at }, i) => ({
    media: item,
    index: at,
    image: images[i]?.data,
    imageError: images[i]?.isError ?? false,
  }));
  const retryImage = useCallback(
    (mediaId: string) => {
      void client.invalidateQueries({ queryKey: ['media-images', eventId, 'full', mediaId] });
    },
    [client, eventId],
  );

  // Blur and flag state for the photo shown, and only that one (D-179). A Photographer never gets
  // here and would be refused.
  const detail = useQuery({
    queryKey: mediaDetailQueryKey(current?.id ?? '', current?.variantVersion ?? 0),
    queryFn: async ({ signal }): Promise<MediaDetailResponse> => {
      try {
        return await getMediaDetail(current!.id, signal);
      } catch (error) {
        refusedOn(error);
        throw error;
      }
    },
    enabled: current !== undefined && (role === 'guest' || role === 'admin'),
    retry: retryUnlessRefused,
  });

  // A 404 on this photo means it left the album: the album refetches and the pager moves on. Any
  // 403 or 404 also rechecks the event, which closes the viewer if the person lost the event.
  function refusedOn(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false;
    if (error.status === 404) {
      void client.invalidateQueries({ queryKey: ['album', eventId] });
      recheckEvent(eventId);
      return true;
    }
    if (error.status === 403) {
      recheckEvent(eventId);
      return true;
    }
    return false;
  }

  const [flagging, setFlagging] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Flag, for a Guest. A repeat answers 200 and changes nothing, so a resend is safe (D-179).
  async function flag(): Promise<ActionResult> {
    if (!current) return 'refused';
    const target = current;
    setFlagging(true);
    try {
      await flagPhoto(target.id);
      client.setQueryData<MediaDetailResponse>(
        mediaDetailQueryKey(target.id, target.variantVersion),
        (before) => (before ? { ...before, flaggedByMe: true } : before),
      );
      return 'done';
    } catch (error) {
      return refusedOn(error) ? 'refused' : 'failed';
    } finally {
      setFlagging(false);
    }
  }

  // Delete, for the uploader or the Admin. Permanent, with no Undo (D-130). A 404 means the photo
  // is already gone, deleted by the other person allowed to or by an earlier try whose answer was
  // lost, so it counts as done. `not_uploader` fails only this action (hb §5.3).
  async function remove(): Promise<ActionResult | 'not_uploader'> {
    if (!current) return 'refused';
    const target = current;
    setDeleting(true);
    try {
      await deleteMedia(target.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        setDeleting(false);
        if (error instanceof ApiError && error.code === 'not_uploader') {
          recheckEvent(eventId);
          return 'not_uploader';
        }
        return refusedOn(error) ? 'refused' : 'failed';
      }
    }
    client.setQueriesData({ queryKey: ['album', eventId] }, (data) =>
      removeFromAlbum(data as Parameters<typeof removeFromAlbum>[0], target.id),
    );
    void client.invalidateQueries({ queryKey: ['album', eventId] });
    void client.invalidateQueries({ queryKey: ['uploaders', eventId] });
    setDeleting(false);
    return 'done';
  }

  let state: ViewerState;
  if (lost) state = lost;
  else if (current) state = 'ready';
  else if ((album.isError && !album.data) || (schedule.isError && !schedule.data)) state = 'error';
  else state = 'loading';

  const isOwnPhoto = current !== undefined && current.uploaderUserId === userId;
  const actions = role && current ? viewerActions(role, isOwnPhoto) : NO_ACTIONS;

  return {
    state,
    role,
    current,
    index,
    count: ids.length,
    slots,
    retryImage,
    retryAlbum: () => {
      void album.refetch();
      void schedule.refetch();
    },
    goTo: setCurrentId,
    subEvent: subEvents.find((subEvent) => subEvent.id === current?.subEventId),
    isOwnPhoto,
    actions,
    detail: detail.data,
    flagging,
    deleting,
    flag,
    remove,
  };
}
