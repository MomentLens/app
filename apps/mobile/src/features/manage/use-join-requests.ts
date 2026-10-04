import {
  ApproveRequestsRequest,
  MAX_JOIN_REQUEST_BATCH,
  type GetEventResponse,
  type ListPendingRequestsResponse,
  type PendingRequest,
  type PendingRequestTarget,
} from '@momentlens/shared-types';
import { onlineManager, useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import { eventQueryKey, recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { eventSettingsQueryKey } from '@/features/manage/use-event-settings';
import {
  ApiError,
  approveRequests,
  blockRequest,
  listPendingRequests,
  rejectRequests,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

export function joinRequestsQueryKey(eventId: string) {
  return ['join-requests', eventId] as const;
}

function recheckAfterRefusal(eventId: string, error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404))
    recheckEvent(eventId);
}

export function joinRequestQueryOptions(eventId: string) {
  return {
    queryKey: joinRequestsQueryKey(eventId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      try {
        return await listPendingRequests(eventId, { cursor: pageParam }, signal);
      } catch (error) {
        recheckAfterRefusal(eventId, error);
        throw error;
      }
    },
    getNextPageParam: (page: ListPendingRequestsResponse) => page.nextCursor ?? undefined,
    retry: retryUnlessRefused,
    networkMode: 'always' as const,
  };
}

// Poll only on the open screen. The shared focus listener refetches on foreground, and the
// screen refetches on navigation focus. Membership has no Realtime or disk cache (D-144).
export function useJoinRequests(eventId: string, focused: boolean) {
  return useInfiniteQuery({
    ...joinRequestQueryOptions(eventId),
    enabled: focused,
    refetchInterval: focused ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function pendingRequests(
  data: InfiniteData<ListPendingRequestsResponse> | undefined,
): PendingRequest[] {
  const unique = new Map<string, PendingRequest>();
  for (const person of data?.pages.flatMap((page) => page.requests) ?? []) {
    // A request cancelled and made again can appear on a later page. Keep its new version and
    // its new queue position, instead of updating the value at its first appearance's position.
    unique.delete(person.userId);
    unique.set(person.userId, person);
  }
  return [...unique.values()];
}

export function loadedRequests(eventId: string) {
  return pendingRequests(
    queryClient.getQueryData<InfiniteData<ListPendingRequestsResponse>>(
      joinRequestsQueryKey(eventId),
    ),
  );
}

export function requestTarget(person: PendingRequest): PendingRequestTarget {
  return { userId: person.userId, expectedVersion: person.accessVersion };
}

export function requestAge(requestedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(requestedAt).getTime()) / 60_000));
  if (minutes === 0) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function selectLoadedRequests(people: PendingRequest[]) {
  return people.slice(0, MAX_JOIN_REQUEST_BATCH).map(requestTarget);
}

// Selections keep the version the Admin chose. A refetch never substitutes a re-made request.
export function retainRequestSelection(
  selection: PendingRequestTarget[],
  people: PendingRequest[],
) {
  return selection.filter((target) =>
    people.some(
      (person) =>
        person.userId === target.userId && person.accessVersion === target.expectedVersion,
    ),
  );
}

export type JoinRequestAction = 'approve' | 'reject' | 'block';
export type RequestConfirmation = {
  title: string;
  message: string;
  label: string;
  destructive: boolean;
};
export type JoinRequestResult = { ok: true } | { ok: false; problem?: string; cancelled?: boolean };
const writing = new Set<string>();

export function joinRequestActionsReady(eventId: string, ownWrite = false): boolean {
  const state = queryClient.getQueryState(joinRequestsQueryKey(eventId));
  const eventState = queryClient.getQueryState(eventQueryKey(eventId));
  const event = queryClient.getQueryData<GetEventResponse>(eventQueryKey(eventId));
  return (
    onlineManager.isOnline() &&
    event?.event.role === 'admin' &&
    !eventState?.error &&
    !eventState?.isInvalidated &&
    state?.status === 'success' &&
    !state.isInvalidated &&
    state.fetchStatus === 'idle' &&
    (ownWrite || !writing.has(eventId))
  );
}

function confirmation(
  action: JoinRequestAction,
  people: PendingRequest[],
): RequestConfirmation | null {
  if (action === 'block')
    return {
      title: `Block ${people[0]!.fullName}?`,
      message: 'They will not be able to join this event through an invite.',
      label: 'Block',
      destructive: true,
    };
  const photographers = people.filter((person) => person.role === 'photographer');
  if (action !== 'approve' || photographers.length === 0) return null;
  return {
    title: people.length === 1 ? 'Approve Photographer?' : `Approve ${people.length} requests?`,
    message: `${photographers.map((person) => person.fullName).join('\n')}\n\n${photographers.length === 1 ? 'This Photographer can' : 'These Photographers can'} upload from anywhere without checking in.`,
    label: 'Approve',
    destructive: false,
  };
}

function actionProblem(error: unknown, places: number | undefined): string {
  if (error instanceof ApiError) {
    if (error.code === 'event_full')
      return places === undefined
        ? 'The selected Guests would exceed the event limit. Refresh to see how many places remain. No one in this batch was approved.'
        : `${places} Guest ${places === 1 ? 'place remains' : 'places remain'}. Choose fewer Guests and try again. No one in this batch was approved.`;
    if (error.code === 'membership_changed')
      return 'A request changed on another phone. Review the refreshed list before trying again. This batch changed no one.';
    if (error.status === 403) return 'You can no longer manage requests in this event.';
    if (error.status === 404) return 'This event is no longer available.';
    if (error.status === 401)
      return 'Your session needs to reconnect. Refresh before trying again.';
    if (error.code === 'invalid_request')
      return 'These requests cannot be changed. Refresh the list.';
  }
  return 'MomentLens could not confirm the result. Review the refreshed list before another action.';
}

async function refreshRequests(eventId: string): Promise<boolean> {
  await queryClient.cancelQueries({ queryKey: joinRequestsQueryKey(eventId) });
  try {
    await queryClient.invalidateQueries(
      { queryKey: joinRequestsQueryKey(eventId) },
      { throwOnError: true },
    );
    const state = queryClient.getQueryState(joinRequestsQueryKey(eventId));
    return state?.status === 'success' && !state.isInvalidated;
  } catch {
    return false;
  }
}

// All writes go through api.ts once. A 401 permits its Auth refresh resend; a lost or timed-out
// response never does. Keep actions locked through confirmation and the subsequent refetch.
export async function saveJoinRequestAction(
  eventId: string,
  targets: PendingRequestTarget[],
  action: JoinRequestAction,
  confirm: (question: RequestConfirmation) => Promise<boolean>,
): Promise<JoinRequestResult> {
  if (!onlineManager.isOnline())
    return { ok: false, problem: 'Connect to the internet to manage requests.' };
  if (
    !ApproveRequestsRequest.safeParse({ targets }).success ||
    (action === 'block' && targets.length !== 1)
  )
    return {
      ok: false,
      problem: 'Choose 1 to 50 different requests. Block applies to one person at a time.',
    };
  const people = loadedRequests(eventId);
  if (
    !joinRequestActionsReady(eventId) ||
    retainRequestSelection(targets, people).length !== targets.length
  )
    return { ok: false, problem: 'Refresh the request list before another action.' };
  const owner = useAuthStore.getState().userId;
  const chosen = targets.map((target) => people.find((person) => person.userId === target.userId)!);
  writing.add(eventId);
  try {
    const question = confirmation(action, chosen);
    if (question && !(await confirm(question))) return { ok: false, cancelled: true };
    // A poll, a foreground refresh or a second phone may change a request while the alert is open.
    if (
      owner !== useAuthStore.getState().userId ||
      !joinRequestActionsReady(eventId, true) ||
      retainRequestSelection(targets, loadedRequests(eventId)).length !== targets.length
    )
      return {
        ok: false,
        problem: 'A request or your access changed. Refresh before trying again.',
      };
    let failure: unknown;
    let failed = false;
    try {
      if (action === 'approve') await approveRequests(eventId, { targets });
      else if (action === 'reject') await rejectRequests(eventId, { targets });
      else
        await blockRequest(eventId, targets[0]!.userId, {
          expectedVersion: targets[0]!.expectedVersion,
        });
    } catch (error) {
      failed = true;
      failure = error;
      recheckAfterRefusal(eventId, error);
    }
    // Settings counts pending people and Attendees lists admitted people. An uncertain write
    // may have changed either, so invalidate them for success and failure alike.
    await queryClient.invalidateQueries({
      queryKey: eventSettingsQueryKey(eventId),
      refetchType: 'none',
    });
    await queryClient.invalidateQueries({ queryKey: ['attendees', eventId], refetchType: 'none' });
    const refreshed = await refreshRequests(eventId);
    if (failed) {
      const places = refreshed
        ? queryClient.getQueryData<InfiniteData<ListPendingRequestsResponse>>(
            joinRequestsQueryKey(eventId),
          )?.pages[0]?.guestPlacesLeft
        : undefined;
      return { ok: false, problem: actionProblem(failure, places) };
    }
    return refreshed
      ? { ok: true }
      : {
          ok: false,
          problem:
            'The action saved, but requests could not be refreshed. Refresh before another action.',
        };
  } finally {
    writing.delete(eventId);
  }
}
