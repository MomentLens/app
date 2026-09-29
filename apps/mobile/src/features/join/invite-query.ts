import type { InviteLookup } from '@momentlens/shared-types';
import { queryOptions } from '@tanstack/react-query';

import { ApiError, resolveInvite } from '@/lib/api';

// POST /invites/resolve as server state. The key names the account, because the answer carries the
// caller's own membership: a preview fetched signed out must not stand in for the one after login.
//
// The link screen and Manual Join Entry fetch it, and Join Confirmation reads the same entry a
// moment later instead of asking again. Thirty seconds covers that hand-off and nothing longer.
// A 4xx is an answer and is not retried; a network failure is retried once.
export function inviteQuery(userId: string | null, lookup: InviteLookup) {
  return queryOptions({
    queryKey: ['invite', userId, lookup] as const,
    queryFn: ({ signal }) => resolveInvite(lookup, signal),
    staleTime: 30_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status !== undefined && error.status < 500) &&
      failureCount < 1,
  });
}

// True for the one answer that means the invite is dead: unknown, revoked, or its event deleted or
// archived (arch:invite).
export function isDeadInvite(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
