import type { InviteLookup, ResolveInviteResponse } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { EVENTS_QUERY_KEY } from '@/features/events/use-events';
import { clearPendingInvite, savePendingInvite } from '@/features/join/pending-invite';
import { joinDestination } from '@/features/join/route';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

// What happens once a link or a code resolves to a live invite (spec §2.3.1, §2.4, D-115). The
// screen that asked is taken off, so going back never returns to a lookup that already answered.
//
// Signed out, the invite is kept and signup opens with its banner. Signing up or logging in then
// opens Join Confirmation ((app)/_layout.tsx). Signed in, the caller's own membership decides.
//
// The link screen and Manual Join Entry sit at the root, above the signed-in or signed-out group.
// A screen inside a group is reached with dismissTo, which pops back to the group already there
// and opens the screen in it. replace would put a second copy of the whole group on the root
// stack. A screen at the root itself is reached with replace.
export function useFollowInvite() {
  const router = useRouter();

  return useCallback(
    (lookup: InviteLookup, answer: ResolveInviteResponse) => {
      const { event, role } = answer;
      const status = useAuthStore.getState().status;

      if (status !== 'signedIn') {
        savePendingInvite({ lookup, eventName: event.name, role });
        // Forced Logout comes first when the session ended, and Login shows the banner after it.
        if (status === 'signedOut') {
          router.dismissTo('/signup');
        } else {
          router.replace('/session-ended');
        }
        return;
      }

      const destination = joinDestination(answer.membership);
      if (destination === 'confirm') {
        savePendingInvite({ lookup, eventName: event.name, role });
        router.dismissTo('/join/confirm');
        return;
      }

      // A member, a requester or a blocked person has nothing left to join through this invite.
      clearPendingInvite();
      void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
      switch (destination) {
        case 'event':
          router.dismissTo({ pathname: '/event/[id]', params: { id: event.id } });
          return;
        case 'pending':
          router.dismissTo({
            pathname: '/join/pending/[eventId]',
            params: { eventId: event.id, name: event.name },
          });
          return;
        case 'blocked':
          router.replace({ pathname: '/join-blocked', params: { name: event.name } });
          return;
      }
    },
    [router],
  );
}
