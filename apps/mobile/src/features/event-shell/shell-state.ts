import type { LostAccess } from '@/features/event-shell/use-event';

// What the Event shell draws below its header: the role's tabs, or one of three states in their
// place.
export type ShellBody = 'tabs' | 'lost' | 'failed' | 'loading';

export interface EventQueryState {
  lost: LostAccess | null;
  hasData: boolean;
  isError: boolean;
  isFetching: boolean;
}

// A refusal counts only once no refetch is running. TanStack Query keeps a query's last error while
// it refetches over data it already has, so a member refused once and since rejoined would see the
// refusal again until the new answer lands. Waiting shows neither the old refusal nor the old event.
// Any other error leaves the cached event up, the copy a guest with no signal needs (spec §4.14).
export function shellBody(query: EventQueryState): ShellBody {
  if (query.lost !== null) {
    return query.isFetching ? 'loading' : 'lost';
  }
  if (query.hasData) {
    return 'tabs';
  }
  return query.isError ? 'failed' : 'loading';
}

// What the shell shows once the API has refused the caller.
export type LostBody = 'pending' | 'no-access' | 'failed' | 'loading';

// The Events list as the shell reads it after a refusal. fetchedAfterMount is true once a fetch
// started since the refusal has answered or failed.
export interface ListState {
  fetchedAfterMount: boolean;
  isSuccess: boolean;
  isError: boolean;
  hasRequest: boolean;
}

// A 404 is final. A 403 is a pending join request only when a list fetched since the refusal still
// holds it (D-118). The copy restored at launch, or one whose refetch failed, can hold a request
// that has since been rejected, so a failed fetch offers to try again rather than guess from it.
export function lostBody(reason: LostAccess, list: ListState): LostBody {
  if (reason === 'not_found') {
    return 'no-access';
  }
  if (!list.fetchedAfterMount) {
    return 'loading';
  }
  if (list.isSuccess) {
    return list.hasRequest ? 'pending' : 'no-access';
  }
  return list.isError ? 'failed' : 'loading';
}
