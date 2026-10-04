import type {
  Attendee,
  GetEventResponse,
  InviteRole,
  ListAttendeesRequest,
  ListAttendeesResponse,
  MembershipRole,
} from '@momentlens/shared-types';
import { onlineManager, useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';

import {
  eventQueryKey,
  lostAccess,
  recheckEvent,
  retryUnlessRefused,
} from '@/features/event-shell/use-event';
import {
  ApiError,
  blockAttendee,
  changeAttendeeRole,
  listAttendees,
  removeAttendee,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';

export type AttendeeFilters = Omit<ListAttendeesRequest, 'cursor'>;

export function attendeeInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const names = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  return names.map((part) => Array.from(part)[0]!.toUpperCase()).join('');
}

type AttendeeListItem =
  | { type: 'header'; key: string; title: string }
  | { type: 'attendee'; key: string; attendee: Attendee; first: boolean; last: boolean };

// The list groups only loaded rows. A changed name between page reads can repeat a user, so
// keep the later page's row once. Filters show labels without inventing whole-event counts.
export function attendeeListItems(attendees: Attendee[]): AttendeeListItem[] {
  const unique = [...new Map(attendees.map((person) => [person.userId, person])).values()];
  const groups = [
    { role: 'admin', title: 'Organizer' },
    { role: 'photographer', title: 'Photographers' },
    { role: 'guest', title: 'Guests' },
  ] as const;
  return groups.flatMap(({ role, title }) => {
    const members = unique.filter((person) => person.role === role);
    return members.length === 0
      ? []
      : [
          { type: 'header' as const, key: `header-${role}`, title },
          ...members.map((attendee, index) => ({
            type: 'attendee' as const,
            key: attendee.userId,
            attendee,
            first: index === 0,
            last: index === members.length - 1,
          })),
        ];
  });
}

export function attendeesQueryKey(eventId: string, filters: AttendeeFilters = {}) {
  return ['attendees', eventId, filters.search ?? '', filters.role ?? 'all'] as const;
}

function recheckAfterRefusal(eventId: string, error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    recheckEvent(eventId);
  }
}

export function attendeeQueryOptions(eventId: string, filters: AttendeeFilters = {}) {
  return {
    queryKey: attendeesQueryKey(eventId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: string | undefined;
      signal: AbortSignal;
    }) => {
      try {
        return await listAttendees(eventId, { ...filters, cursor: pageParam }, signal);
      } catch (error) {
        recheckAfterRefusal(eventId, error);
        throw error;
      }
    },
    getNextPageParam: (page: ListAttendeesResponse) => page.nextCursor ?? undefined,
    retry: retryUnlessRefused,
    networkMode: 'always' as const,
  };
}

// The pages stay in TanStack Query memory. No persistence, membership Realtime or direct table
// reads. The app's focus and network listeners refresh this query on foreground and reconnect.
export function useAttendees(eventId: string, filters: AttendeeFilters = {}, enabled = true) {
  return useInfiniteQuery({ ...attendeeQueryOptions(eventId, filters), enabled });
}

// A person repeated across pages after a name change keeps the later row, as attendeeListItems
// does, so the sheet draws and acts on the same version.
export function findAttendee(
  data: InfiniteData<ListAttendeesResponse> | undefined,
  userId: string,
): Attendee | undefined {
  return data?.pages
    .flatMap((page) => page.attendees)
    .reverse()
    .find((attendee) => attendee.userId === userId);
}

export function loadedAttendee(eventId: string, filters: AttendeeFilters, userId: string) {
  return findAttendee(
    queryClient.getQueryData<InfiniteData<ListAttendeesResponse>>(
      attendeesQueryKey(eventId, filters),
    ),
    userId,
  );
}

// Where an open attendee sheet sends the Admin. A target that left the loaded list goes back to
// Attendees. A changed role or lost access goes to the Event shell, which draws the new tabs or
// Access Removed. Any other event error, a network failure or a 5xx, keeps the sheet open with its
// actions disabled by attendeeActionsReady, as the shell keeps its tabs (D-118).
export function attendeeSheetExit(
  found: boolean,
  eventRole: MembershipRole | undefined,
  eventError: unknown,
): 'list' | 'event' | null {
  if (!found) return 'list';
  if (eventRole !== undefined && eventRole !== 'admin') return 'event';
  return lostAccess(eventError) === null ? null : 'event';
}

export type AttendeeAction =
  { kind: 'role'; role: InviteRole } | { kind: 'remove' } | { kind: 'block' };
export type AttendeeActionResult =
  { ok: true } | { ok: false; problem: string; returnToList?: boolean };
const writing = new Set<string>();

export function attendeeProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'membership_changed')
      return 'This attendee changed on another phone. Review the refreshed list before trying again.';
    if (error.code === 'event_full')
      return 'This event already has 150 Guests. The role stayed unchanged.';
    if (error.status === 403) return 'You can no longer manage attendees in this event.';
    if (error.status === 404) return 'The event or attendee is no longer available.';
    if (error.status === 401)
      return 'Your session needs to reconnect. Refresh the list before trying again.';
    if (error.code === 'invalid_request')
      return 'This attendee cannot be changed. Refresh the list.';
  }
  return 'MomentLens could not confirm the result. Refresh the list before another action.';
}

export function attendeeActionsReady(eventId: string, filters: AttendeeFilters): boolean {
  const state = queryClient.getQueryState(attendeesQueryKey(eventId, filters));
  const event = queryClient.getQueryData<GetEventResponse>(eventQueryKey(eventId));
  const eventState = queryClient.getQueryState(eventQueryKey(eventId));
  return (
    onlineManager.isOnline() &&
    event?.event.role === 'admin' &&
    !eventState?.error &&
    state?.status === 'success' &&
    !state.isInvalidated &&
    state.fetchStatus === 'idle' &&
    !writing.has(eventId)
  );
}

async function refreshAttendees(eventId: string) {
  // Cancel reads made before the write, so their old answers cannot replace the refresh. Every
  // loaded filter is invalidated, so none can act on an old version, but only the list on screen
  // refetches now. Another filter refetches when the Admin opens it.
  await queryClient.cancelQueries({ queryKey: ['attendees', eventId] });
  await queryClient.invalidateQueries({ queryKey: ['attendees', eventId] });
}

// No mutation queue, and no retry of a write whose result is uncertain. api.ts resends once after
// a 401, which the API answers before the handler runs. A failed refresh leaves the query
// invalidated or in error, which refuses the next write even if its old data still draws (D-143).
export async function saveAttendeeAction(
  eventId: string,
  filters: AttendeeFilters,
  target: Attendee,
  action: AttendeeAction,
): Promise<AttendeeActionResult> {
  if (!onlineManager.isOnline())
    return { ok: false, problem: 'Connect to the internet to change an attendee.' };
  const current = loadedAttendee(eventId, filters, target.userId);
  if (!current)
    return {
      ok: false,
      problem: 'This attendee is no longer in the loaded list.',
      returnToList: true,
    };
  if (target.role === 'admin' || current.role === 'admin')
    return { ok: false, problem: "The event's Admin cannot be changed." };
  if (current.accessVersion !== target.accessVersion || !attendeeActionsReady(eventId, filters)) {
    return { ok: false, problem: 'Refresh the attendee list before another action.' };
  }

  writing.add(eventId);
  try {
    const body = { expectedVersion: target.accessVersion };
    if (action.kind === 'role')
      await changeAttendeeRole(eventId, target.userId, { ...body, role: action.role });
    else if (action.kind === 'remove') await removeAttendee(eventId, target.userId, body);
    else await blockAttendee(eventId, target.userId, body);
    await refreshAttendees(eventId);
    return { ok: true };
  } catch (error) {
    recheckAfterRefusal(eventId, error);
    await refreshAttendees(eventId);
    return { ok: false, problem: attendeeProblem(error) };
  } finally {
    writing.delete(eventId);
  }
}
