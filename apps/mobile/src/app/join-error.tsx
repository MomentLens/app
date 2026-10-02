import { useRouter } from 'expo-router';

import { Button } from '@/components/ui/button';
import { AuthScreen } from '@/features/auth/auth-screen';
import { useAuthStore } from '@/stores/auth';
import { byPlatform } from '@/lib/copy';

// Join Error (spec §2.5.8), for a dead link only: revoked, or its event deleted or archived. An
// invite has no time limit, so "expired" means one of those (arch:invite). The copy is spec §5.1's.
// It sits outside both guarded groups, because a dead link can be opened signed in or not.
export default function JoinErrorScreen() {
  const router = useRouter();
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

  return (
    <AuthScreen
      variant="status"
      icon="link-2-off"
      title="This invite has expired"
      subtitle="This link has expired or been revoked. Contact the event organizer."
      footer={
        <>
          <Button
            label={
              signedIn
                ? byPlatform('Back to Events', 'Back to events')
                : byPlatform('Back to Log In', 'Back to log in')
            }
            onPress={leave}
          />
          <Button
            label={byPlatform('Join with a Code Instead', 'Join with a code instead')}
            variant="quiet"
            onPress={() => router.replace('/join-code')}
          />
        </>
      }
    />
  );
}
