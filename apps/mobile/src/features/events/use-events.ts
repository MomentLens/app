import type {
  EventSummary,
  JoinRequest,
  ListEventsResponse,
  PresignedImage,
} from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';

import { ApiError, listEvents } from '@/lib/api';
import { PERSISTED_QUERY, queryClient } from '@/lib/query-client';

export const EVENTS_QUERY_KEY = ['events'] as const;

interface UseEventsOptions {
  // Pending Approval polls the list for its request (D-115). Nothing else sets one.
  refetchInterval?: number;
}

// GET /events as server state (apps/mobile/AGENTS.md). api.ts has already refreshed and retried
// once by the time a 401 reaches here, so it is not retried again. It survives a restart like the
// event does, because a cold start with no signal reaches an event only through this list (D-119).
export function useEvents({ refetchInterval }: UseEventsOptions = {}) {
  return useQuery({
    queryKey: EVENTS_QUERY_KEY,
    queryFn: ({ signal }) => listEvents(signal),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 1,
    refetchInterval,
    ...PERSISTED_QUERY,
  });
}

function withEvent(list: ListEventsResponse | undefined, event: EventSummary): ListEventsResponse {
  const others = (list?.events ?? []).filter((existing) => existing.id !== event.id);
  return { events: [...others, event], joinRequests: list?.joinRequests ?? [] };
}

// Puts an event the create returned into the list straight away, so the landing screen and the
// Events tab have it before the refetch that follows lands.
export function rememberCreatedEvent(event: EventSummary): void {
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, (list) => withEvent(list, event));
  void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
}

// The same once its cover is set.
export function rememberCover(eventId: string, cover: PresignedImage): void {
  rememberEventChanges(eventId, { cover });
}

// Puts what the Admin saved in Event Settings into the listed event, so the Events tab shows the
// new name or cover without waiting for its next fetch (D-142). A new cover carries the cacheKey
// of its own upload, so the card stops showing the old one (root invariant 2).
export function rememberEventChanges(
  eventId: string,
  changes: Partial<Pick<EventSummary, 'name' | 'cover'>>,
): void {
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, (list) => {
    const event = list?.events.find((existing) => existing.id === eventId);
    return event ? withEvent(list, { ...event, ...changes }) : list;
  });
}

// Puts a join that came back pending into the list straight away, so Pending Approval finds its
// request before the refetch lands, and the Events tab shows its card when the person goes back.
export function rememberJoinRequest(request: JoinRequest): void {
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, (list) => ({
    events: list?.events ?? [],
    joinRequests: [
      ...(list?.joinRequests ?? []).filter((existing) => existing.eventId !== request.eventId),
      request,
    ],
  }));
  void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
}

// Takes a cancelled request off the list straight away, so the Events tab does not show its card
// until the refetch lands.
export function forgetJoinRequest(eventId: string): void {
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, (list) =>
    list
      ? {
          ...list,
          joinRequests: list.joinRequests.filter((request) => request.eventId !== eventId),
        }
      : list,
  );
  void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
}
