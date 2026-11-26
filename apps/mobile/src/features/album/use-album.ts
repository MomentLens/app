import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { ApiError, listAlbum, listPeople, listUploaders } from '@/lib/api';

// The album's query parameters. `personId` and `clusterId` are exclusive; each stacks with the
// other two (spec §2.5.2).
export interface AlbumFilters {
  subEventId?: string;
  uploaderId?: string;
  personId?: string;
  clusterId?: string;
}

// The filters the More sheet's counts follow: every one but the sub-event chip.
export type IdentityFilters = Omit<AlbumFilters, 'subEventId'>;

export function albumQueryKey(eventId: string, filters: AlbumFilters = {}) {
  return ['album', eventId, filters] as const;
}

export function uploadersQueryKey(eventId: string) {
  return ['uploaders', eventId] as const;
}

export function peopleQueryKey(eventId: string) {
  return ['people', eventId] as const;
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

// Every section's count under the identity filters alone, for the More sheet. With a chip active,
// the album's own counts cover that one sub-event, so the sheet reads the first page of the
// chip-free album instead. It sits under ['album', eventId], so Realtime refreshes it too, and it
// is only enabled while the sheet needs it.
export function useSectionCounts(eventId: string, filters: IdentityFilters, enabled: boolean) {
  return useQuery({
    queryKey: ['album', eventId, 'section-counts', filters] as const,
    queryFn: async ({ signal }) => {
      try {
        return await listAlbum(eventId, filters, signal);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    select: (page) => page.sectionCounts ?? [],
    retry: retryUnlessRefused,
    enabled,
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

// GET /events/{eventId}/media/people for the People half of the filter sheet. It reads again every
// time the sheet opens, because a match can change without anything the app is told about: a
// reference added, `reprocess`, or someone turning Do Not Publish on (D-176). Not persisted.
export function usePeople(eventId: string) {
  return useQuery({
    queryKey: peopleQueryKey(eventId),
    queryFn: async ({ signal }) => {
      try {
        return await listPeople(eventId, signal);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    retry: retryUnlessRefused,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
