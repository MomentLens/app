import type { InviteRole, ListInvitesResponse, ManagedInvite } from '@momentlens/shared-types';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { setStringAsync } from 'expo-clipboard';
import { Share } from 'react-native';

import { eventQueryKey, recheckEvent } from '@/features/event-shell/use-event';
import {
  inviteLink,
  inviteProblem,
  inviteShareMessage,
  type InviteAction,
  type InviteOutcome,
} from '@/features/manage/invite';
import { AccountChangedError, ApiError, getEvent, listInvites, regenerateInvite } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

// Logging back into the same account still ends actions started before logout.
let accountGeneration = 0;
useAuthStore.subscribe((current, previous) => {
  if (current.userId !== previous.userId || current.status !== previous.status) {
    accountGeneration += 1;
  }
});

export function inviteQueryKey(eventId: string, owner: string | null) {
  return ['managed-invites', owner, eventId] as const;
}

function requireAccount(
  owner: string | null,
  generation = accountGeneration,
): asserts owner is string {
  const current = useAuthStore.getState();
  if (
    owner === null ||
    current.userId !== owner ||
    current.status !== 'signedIn' ||
    generation !== accountGeneration
  ) {
    throw new AccountChangedError();
  }
}

function requireOnline() {
  if (!onlineManager.isOnline()) {
    throw new ApiError('Invites require an online read.');
  }
}

function recheckRefusal(eventId: string, error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    recheckEvent(eventId);
  }
}

export function inviteQueryOptions(eventId: string, owner: string | null) {
  return {
    queryKey: inviteQueryKey(eventId, owner),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const generation = accountGeneration;
      requireAccount(owner);
      requireOnline();
      try {
        const response = await listInvites(owner, eventId, signal);
        requireAccount(owner, generation);
        return response;
      } catch (error) {
        recheckRefusal(eventId, error);
        throw error;
      }
    },
    enabled: owner !== null,
    staleTime: 0,
    gcTime: 0,
    meta: { persist: false },
    networkMode: 'always' as const,
    retry: false as const,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
    refetchOnReconnect: 'always' as const,
  };
}

export function useInvites(eventId: string) {
  const owner = useAuthStore((state) => state.userId);
  return useQuery(inviteQueryOptions(eventId, owner));
}

// Cancel any older read so this action waits for a new server snapshot.
export async function freshInvites(eventId: string, owner: string): Promise<ListInvitesResponse> {
  const generation = accountGeneration;
  requireAccount(owner);
  requireOnline();
  await queryClient.cancelQueries({ queryKey: inviteQueryKey(eventId, owner), exact: true });
  requireAccount(owner, generation);
  return queryClient.fetchQuery(inviteQueryOptions(eventId, owner));
}

function problem(error: unknown, action: 'read' | 'replace'): string {
  if (error instanceof AccountChangedError)
    return 'The signed-in account changed. Open Invite again.';
  return inviteProblem(error instanceof ApiError ? error : {}, action);
}

export async function rotateInvite(
  eventId: string,
  displayed: ManagedInvite,
  owner: string,
): Promise<InviteOutcome<ManagedInvite>> {
  const queryKey = inviteQueryKey(eventId, owner);
  const generation = accountGeneration;
  let sent = false;
  try {
    requireAccount(owner, generation);
    requireOnline();
    const state = queryClient.getQueryState<ListInvitesResponse>(queryKey);
    if (!state?.data || state.isInvalidated || state.error) {
      return { ok: false, problem: 'Refresh the invites before replacing a link and code.' };
    }
    if (
      !state.data.invites.some(
        (invite) => invite.role === displayed.role && invite.id === displayed.id,
      )
    ) {
      return { ok: false, problem: inviteProblem({ code: 'invite_changed' }, 'replace') };
    }
    await queryClient.cancelQueries({ queryKey, exact: true });
    await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
    requireAccount(owner, generation);
    requireOnline();
    sent = true;
    const { invite } = await regenerateInvite(owner, eventId, {
      role: displayed.role,
      expectedInviteId: displayed.id,
    });
    requireAccount(owner, generation);
    // A foreground read can have started while the POST was pending.
    await queryClient.cancelQueries({ queryKey, exact: true });
    requireAccount(owner, generation);
    const current = queryClient.getQueryData<ListInvitesResponse>(queryKey);
    if (current) {
      queryClient.setQueryData<ListInvitesResponse>(queryKey, {
        invites: current.invites.map((row) => (row.role === invite.role ? invite : row)),
      });
    }
    return { ok: true, value: invite };
  } catch (error) {
    recheckRefusal(eventId, error);
    if (sent && generation === accountGeneration && useAuthStore.getState().userId === owner) {
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
      // A failed recovery keeps the query invalid or in error, which blocks another rotation.
      await freshInvites(eventId, owner).catch(() => undefined);
    }
    return { ok: false, problem: problem(error, sent ? 'replace' : 'read') };
  }
}

export async function sendInvite(
  eventId: string,
  role: InviteRole,
  action: InviteAction,
  owner: string,
): Promise<InviteOutcome<string | null>> {
  const generation = accountGeneration;
  try {
    requireAccount(owner, generation);
    requireOnline();
    // Credential reads permit archived events. Check the event's current status separately.
    const { event } = await getEvent(eventId);
    requireAccount(owner, generation);
    queryClient.setQueryData(eventQueryKey(eventId), { event });
    if (event.role !== 'admin' || event.archivedAt !== null) {
      recheckEvent(eventId);
      return {
        ok: false,
        problem: 'Invites are inactive while this event is archived or you are not its Admin.',
      };
    }
    const { invites } = await freshInvites(eventId, owner);
    requireAccount(owner, generation);
    requireOnline();
    const invite = invites.find((candidate) => candidate.role === role);
    if (!invite) throw new ApiError('The requested role is missing.', 500, 'internal_error');
    if (action === 'share') {
      await Share.share({ message: inviteShareMessage(event.name, invite) });
      return { ok: true, value: null };
    }
    const copied = await setStringAsync(action === 'code' ? invite.code : inviteLink(invite));
    if (!copied) return { ok: false, problem: 'Could not copy this invite. Try again.' };
    return { ok: true, value: action === 'code' ? 'Code copied.' : 'Link copied.' };
  } catch (error) {
    recheckRefusal(eventId, error);
    return { ok: false, problem: problem(error, 'read') };
  }
}
