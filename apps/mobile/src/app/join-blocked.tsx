import { useLocalSearchParams, useRouter } from 'expo-router';

import { Button } from '@/components/ui/button';
import { AuthScreen } from '@/features/auth/auth-screen';
import { useAuthStore } from '@/stores/auth';
import { byPlatform } from '@/lib/copy';

// Join Blocked (spec §2.5.8, D-115): the event's Admin blocked this person, so they cannot join
// through any invite. It says so plainly and offers no join action. Never Join Error, whose
// "expired or revoked" would be false, and never Access Removed, which is for a member losing
// access mid-session (hb §5.3).
export default function JoinBlockedScreen() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const signedIn = useAuthStore((state) => state.status === 'signedIn');

  // Back to whatever is underneath, the Events list or Login, rather than a replace that would put
  // a second copy of that group on the root stack. A link opened from cold has nothing underneath.
  function leave() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(signedIn ? '/' : '/login');
    }
  }
  const event = typeof name === 'string' && name !== '' ? name : 'this event';

  return (
    <AuthScreen
      variant="status"
      icon="ban"
      title="You can't join this event"
      subtitle={`The organizer of ${event} has blocked you from joining it. If you think this is a mistake, contact them.`}
      footer={
        <Button
          label={
            signedIn
              ? byPlatform('Back to Events', 'Back to events')
              : byPlatform('Back to Log In', 'Back to log in')
          }
          onPress={leave}
        />
      }
    />
  );
}
