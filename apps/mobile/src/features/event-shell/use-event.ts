import type { GetEventResponse, ListEventsResponse } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';

import { EVENTS_QUERY_KEY } from '@/features/events/use-events';
import { ApiError, getEvent } from '@/lib/api';
import { PERSISTED_QUERY, queryClient } from '@/lib/query-client';

export function eventQueryKey(eventId: string) {
  return ['event', eventId] as const;
}

// Why an event call says the caller cannot see this event any more (D-118). A 403 is not_member,
// the only 403 GET /events/{eventId} answers: removed, blocked, pending or never a member. A 404 is
// deleted or unknown, and a 400 an id that is no uuid, which only a hand-typed link can carry.
export type LostAccess = 'not_member' | 'not_found';

export function lostAccess(error: unknown): LostAccess | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  if (error.status === 403) {
    return 'not_member';
  }
  if (error.status === 404 || error.status === 400) {
    return 'not_found';
  }
  return null;
}

// The event as GET /events listed it, so an event opened from the Events tab draws at once. The
// list's age goes with it, so the shell still asks the API before trusting the role.
function seedFromList(eventId: string): GetEventResponse | undefined {
  const list = queryClient.getQueryData<ListEventsResponse>(EVENTS_QUERY_KEY);
  const event = list?.events.find((candidate) => candidate.id === eventId);
  return event ? { event } : undefined;
}

// GET /events/{eventId}, the one query every tab of the Event shell reads its event and role from
// (hb §16.5, D-118). It refetches whenever the shell mounts and whenever the app comes back to the
// foreground, which is how a role change or a removal reaches the phone, and it survives a restart
// so a guest with no signal still gets into the event (spec §4.14).
export function useEvent(eventId: string) {
  return useQuery({
    queryKey: eventQueryKey(eventId),
    queryFn: ({ signal }) => getEvent(eventId, signal),
    initialData: () => seedFromList(eventId),
    initialDataUpdatedAt: () => queryClient.getQueryState(EVENTS_QUERY_KEY)?.dataUpdatedAt,
    // A 4xx is the answer, not a hiccup. api.ts has already refreshed and retried a 401 once.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status !== undefined && error.status < 500) &&
      failureCount < 1,
    ...PERSISTED_QUERY,
  });
}
