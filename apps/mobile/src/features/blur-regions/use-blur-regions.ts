import type {
  AlbumMediaItem,
  BlurRect,
  BlurRegion,
  ListAlbumResponse,
  ListBlurRegionsResponse,
} from '@momentlens/shared-types';
import {
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryCacheNotifyEvent,
} from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { fullImageQuery } from '@/features/album/full-image';
import { recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { ApiError, addBlurRegion, listBlurRegions, removeBlurRegion } from '@/lib/api';

export function blurRegionsQueryKey(mediaId: string) {
  return ['blur-regions', mediaId] as const;
}

// A refusal that means the caller lost the photo or their place in the event. The event query
// decides what the shell shows next, as the album does (use-album.ts).
function refused(eventId: string, error: unknown): boolean {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    recheckEvent(eventId);
    return true;
  }
  return false;
}

// GET /media/{mediaId}/blur-regions: a Guest's own regions, or every region for the Admin (D-170).
export function useBlurRegions(eventId: string, mediaId: string) {
  return useQuery({
    queryKey: blurRegionsQueryKey(mediaId),
    queryFn: async ({ signal }) => {
      try {
        return await listBlurRegions(mediaId, signal);
      } catch (error) {
        refused(eventId, error);
        throw error;
      }
    },
    retry: retryUnlessRefused,
  });
}

type AlbumData = InfiniteData<ListAlbumResponse> | ListAlbumResponse | undefined;

function findInAlbum(data: AlbumData, mediaId: string): AlbumMediaItem | undefined {
  if (!data) return undefined;
  const pages = 'pages' in data ? data.pages : [data];
  for (const page of pages) {
    const found = page.media.find((item) => item.id === mediaId);
    if (found) return found;
  }
  return undefined;
}

// A query-cache listener that calls `onChange` only when one of this event's album queries gets
// new data or goes. A query is `added` while some component renders, and answering that with a
// re-render is a React error (setState in render). A new album query has no data until an
// `updated` event anyway.
export function albumChangeListener(eventId: string, onChange: () => void) {
  return (event: QueryCacheNotifyEvent) => {
    const [root, id] = event.query.queryKey;
    if (root !== 'album' || id !== eventId) return;
    if (event.type === 'updated' || event.type === 'removed') onChange();
  };
}

// The photo as the album last loaded it. Realtime refetches the album when the worker bumps
// `variant_version` after a blur_region job (use-media-realtime.ts), and this follows, so the
// screen signs the regenerated file instead of keeping the old one (root invariant 2).
export function useAlbumItem(eventId: string, mediaId: string): AlbumMediaItem | undefined {
  const client = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) =>
      client.getQueryCache().subscribe(albumChangeListener(eventId, onChange)),
    [client, eventId],
  );
  const read = useCallback(
    () =>
      newestInAlbums(
        client.getQueriesData<AlbumData>({ queryKey: ['album', eventId] }).map(([, data]) => data),
        mediaId,
      ),
    [client, eventId, mediaId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

// The photo's newest copy across every cached album query of the event. Realtime's invalidate
// refetches only the queries on screen, so a filter left earlier keeps an old `variant_version`,
// and the first copy found could be that one.
export function newestInAlbums(
  albums: readonly AlbumData[],
  mediaId: string,
): AlbumMediaItem | undefined {
  let newest: AlbumMediaItem | undefined;
  for (const data of albums) {
    const found = findInAlbum(data, mediaId);
    if (found && (!newest || found.variantVersion > newest.variantVersion)) newest = found;
  }
  return newest;
}

// The photo's full image for this viewer, shared with the single photo view (use-album-images.ts).
export function useFullImage(eventId: string, mediaId: string, variantVersion: number | undefined) {
  return useQuery(fullImageQuery(eventId, mediaId, variantVersion));
}

// A region saved on this phone and not yet confirmed by the API. It draws solid at once, so the
// person who drew it sees it covered (D-170). A failed one keeps its id, so Try Again resends the
// same region and the API stores it at most once.
export interface PendingRegion {
  id: string;
  rect: BlurRect;
  failed: boolean;
}

export type BlurProblem = 'photo_gone' | 'no_access' | null;

export function useBlurEditing(eventId: string, mediaId: string) {
  const client = useQueryClient();
  const key = useMemo(() => blurRegionsQueryKey(mediaId), [mediaId]);
  const [pending, setPending] = useState<PendingRegion[]>([]);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<BlurProblem>(null);

  const stopOn = useCallback(
    (error: unknown): boolean => {
      if (!(error instanceof ApiError)) return false;
      if (error.status === 404) {
        setProblem('photo_gone');
        recheckEvent(eventId);
        return true;
      }
      if (error.status === 403) {
        setProblem('no_access');
        recheckEvent(eventId);
        return true;
      }
      return false;
    },
    [eventId],
  );

  const send = useCallback(
    async (region: PendingRegion) => {
      setPending((current) =>
        current.map((item) => (item.id === region.id ? { ...item, failed: false } : item)),
      );
      try {
        const list = await addBlurRegion(mediaId, { id: region.id, ...region.rect });
        client.setQueryData<ListBlurRegionsResponse>(key, list);
        setPending((current) => current.filter((item) => item.id !== region.id));
      } catch (error) {
        if (stopOn(error)) {
          setPending((current) => current.filter((item) => item.id !== region.id));
          return;
        }
        setPending((current) =>
          current.map((item) => (item.id === region.id ? { ...item, failed: true } : item)),
        );
      }
    },
    [client, key, mediaId, stopOn],
  );

  const add = useCallback(
    (rect: BlurRect) => {
      const region: PendingRegion = { id: randomUUID(), rect, failed: false };
      setPending((current) => [...current, region]);
      void send(region);
    },
    [send],
  );

  const discard = useCallback((id: string) => {
    setPending((current) => current.filter((item) => item.id !== id));
  }, []);

  // Removing hides the region at once and puts it back if the API refuses. A 404 means it is
  // already gone, which a resend after a lost answer also gets, so it counts as done.
  const remove = useCallback(
    async (region: BlurRegion): Promise<'done' | 'failed'> => {
      setRemoving((current) => new Set(current).add(region.id));
      try {
        const list = await removeBlurRegion(region.id);
        client.setQueryData<ListBlurRegionsResponse>(key, list);
        return 'done';
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          client.setQueryData<ListBlurRegionsResponse>(key, (current) =>
            current
              ? { regions: current.regions.filter((item) => item.id !== region.id) }
              : current,
          );
          void client.invalidateQueries({ queryKey: key, exact: true });
          return 'done';
        }
        if (error instanceof ApiError && error.status === 403) {
          // not_drawer, not_member or wrong_role: the list on this phone is out of date.
          void client.invalidateQueries({ queryKey: key, exact: true });
          recheckEvent(eventId);
        }
        return 'failed';
      } finally {
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(region.id);
          return next;
        });
      }
    },
    [client, eventId, key],
  );

  return useMemo(
    () => ({ pending, removing, problem, add, retry: send, discard, remove }),
    [pending, removing, problem, add, send, discard, remove],
  );
}
