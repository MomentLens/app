import { InviteToken } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator } from 'react-native';

import { Button } from '@/components/ui/button';
import { AuthScreen } from '@/features/auth/auth-screen';
import { useFollowInvite } from '@/features/join/follow-invite';
import { inviteQuery, isDeadInvite } from '@/features/join/invite-query';
import { useAuthStore } from '@/stores/auth';

// Where momentlens://invite/{token} lands (D-101), signed in or not, so it sits outside both
// guarded groups. It looks the invite up and hands over at once: a dead one to Join Error, a live
// one to signup or to wherever the caller's membership says (features/join/follow-invite.ts). A
// token that is not even the right shape is a dead link without asking the API.
export default function InviteLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token: string }>();
  const token = InviteToken.safeParse(params.token);
  const userId = useAuthStore((state) => state.userId);
  const follow = useFollowInvite();
  const lookup = useMemo(() => ({ token: token.data ?? '' }), [token.data]);
  const invite = useQuery({ ...inviteQuery(userId, lookup), enabled: token.success });
  const followed = useRef(false);

  useEffect(() => {
    if (invite.data && !followed.current) {
      followed.current = true;
      follow(lookup, invite.data);
    }
  }, [invite.data, follow, lookup]);

  function leave() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  if (!token.success || isDeadInvite(invite.error)) {
    return <Redirect href="/join-error" />;
  }

  if (invite.isError) {
    return (
      <AuthScreen
        icon="circle-alert"
        title="The invite could not be opened"
        subtitle="MomentLens could not be reached. Check your connection, then try the link again."
        footer={
          <>
            <Button
              label={invite.isFetching ? 'Trying again' : 'Try again'}
              busy={invite.isFetching}
              onPress={() => void invite.refetch()}
            />
            <Button label="Cancel" variant="secondary" onPress={leave} />
          </>
        }
      />
    );
  }

  return (
    <AuthScreen title="Opening your invite">
      <ActivityIndicator className="text-accent" />
    </AuthScreen>
  );
}
