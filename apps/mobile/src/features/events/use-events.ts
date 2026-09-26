import type { EventSummary, ListEventsResponse, PresignedImage } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';

import { ApiError, listEvents } from '@/lib/api';
import { queryClient } from '@/lib/query-client';

export const EVENTS_QUERY_KEY = ['events'] as const;

// GET /events as server state (apps/mobile/CLAUDE.md). api.ts has already refreshed and retried
// once by the time a 401 reaches here, so it is not retried again.
export function useEvents() {
  return useQuery({
    queryKey: EVENTS_QUERY_KEY,
    queryFn: ({ signal }) => listEvents(signal),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 1,
  });
}

function withEvent(list: ListEventsResponse | undefined, event: EventSummary): ListEventsResponse {
  const others = (list?.events ?? []).filter((existing) => existing.id !== event.id);
  return { events: [...others, event] };
}

// Puts an event the create returned into the list straight away, so the landing screen and the
// Events tab have it before the refetch that follows lands.
export function rememberCreatedEvent(event: EventSummary): void {
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, (list) => withEvent(list, event));
  void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
}

// The same once its cover is set.
export function rememberCover(eventId: string, cover: PresignedImage): void {
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, (list) => {
    const event = list?.events.find((existing) => existing.id === eventId);
    return event ? withEvent(list, { ...event, cover }) : list;
  });
}
