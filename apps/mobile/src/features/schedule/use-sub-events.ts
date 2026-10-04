import type { ErrorCode, ListSubEventsResponse } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';

import { eventQueryKey, recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { EVENTS_QUERY_KEY } from '@/features/events/use-events';
import { writeProblem, type ScheduleWrite } from '@/features/schedule/schedule';
import { ApiError, listSubEvents } from '@/lib/api';
import { PERSISTED_QUERY, queryClient } from '@/lib/query-client';

// A key of its own rather than one under ['event', eventId]. Invalidating a key also invalidates
// every key that starts with it, so the event's refetches would drag the schedule along.
export function subEventsQueryKey(eventId: string) {
  return ['sub-events', eventId] as const;
}

// GET /events/{eventId}/sub-events as server state, for every role's Schedule and later for the
// capture button (S-09) and My Media (S-10). It survives a restart like the event does, so the
// Schedule opens offline, and refetches on foreground and reconnect (D-118, D-121).
export function useSubEvents(eventId: string) {
  return useQuery({
    queryKey: subEventsQueryKey(eventId),
    queryFn: async ({ signal }) => {
      try {
        return await listSubEvents(eventId, signal);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    retry: retryUnlessRefused,
    ...PERSISTED_QUERY,
  });
}

// Every write answers with the whole schedule, which replaces the cached one. A fetch already in
// flight is cancelled first, so an older answer cannot land over it. The event's span may have
// moved, so the event and the Events list refetch, and for one fetch the two may disagree (D-121).
async function rememberSchedule(eventId: string, schedule: ListSubEventsResponse): Promise<void> {
  const queryKey = subEventsQueryKey(eventId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, schedule);
  void queryClient.invalidateQueries({ queryKey: eventQueryKey(eventId), exact: true });
  void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY, exact: true });
}

export interface WriteFailure {
  // What the Admin reads (writeProblem).
  message: string;
  code: ErrorCode | undefined;
}

// Runs one of the Admin's writes and answers null when it is done, or why it failed. A write
// needs a connection and is never queued (D-121); offline it fails at once and says so.
//
// Whatever went wrong, the cached schedule may be out of date: another phone changed it, or a write
// that timed out landed anyway. It refetches either way. A 404 on a delete is a delete that already
// happened, from this phone's lost first attempt or from another phone, so it counts as done.
export async function writeSchedule(
  eventId: string,
  write: ScheduleWrite,
  send: () => Promise<ListSubEventsResponse>,
): Promise<WriteFailure | null> {
  try {
    await rememberSchedule(eventId, await send());
    return null;
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: subEventsQueryKey(eventId), exact: true });
    const failure: { status?: number; code?: ErrorCode } =
      error instanceof ApiError ? error : { status: 500 };
    if (write === 'delete' && failure.status === 404) {
      return null;
    }
    if (failure.status === 403 || failure.status === 404) {
      recheckEvent(eventId);
    }
    return { message: writeProblem(failure, write), code: failure.code };
  }
}
