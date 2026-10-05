import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { ApiError, listAlbum, listUploaders } from '@/lib/api';

export interface AlbumFilters {
  subEventId?: string;
  uploaderId?: string;
}

export function albumQueryKey(eventId: string, filters: AlbumFilters = {}) {
  return ['album', eventId, filters] as const;
}

export function uploadersQueryKey(eventId: string) {
  return ['uploaders', eventId] as const;
}

// GET /events/{eventId}/media as infinite query.
// The album query is NOT persisted across a restart (D-148, root invariant 2).
// A persisted page holds the variant_version it was loaded with, so offline it would show a
// pre-blur file from disk cache.
export function useAlbum(eventId: string, filters: AlbumFilters = {}) {
  return useInfiniteQuery({
    queryKey: albumQueryKey(eventId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await listAlbum(eventId, { ...filters, cursor: pageParam }, signal);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: retryUnlessRefused,
  });
}

// GET /events/{eventId}/media/uploaders for the filter sheet.
export function useUploaders(eventId: string) {
  return useQuery({
    queryKey: uploadersQueryKey(eventId),
    queryFn: async ({ signal }) => {
      try {
        return await listUploaders(eventId, signal);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    retry: retryUnlessRefused,
    staleTime: 60 * 1000,
  });
}
