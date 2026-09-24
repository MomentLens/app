import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

import { clearAccountCaches, isChosenLogout } from '@/features/auth/logout';
import { storedSessionUserId, supabase, userIdAtLaunch } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';

// Keeps useAuthStore in step with Supabase Auth. The root layout calls startSessionSync once, at
// module scope, so the store is right before the first render and the app never waits on the
// network to decide what to show.
//
// Two things auth-js 2.116.0 does shape this file:
// - Its first event, INITIAL_SESSION, says "no session" when a stored session could not be
//   refreshed for lack of network, although the session is still stored and will refresh once the
//   phone is back online. Believing it would show Login on every offline launch an hour after the
//   last use, so the store starts from what storage holds and INITIAL_SESSION is ignored.
// - It removes a stored session, and sends SIGNED_OUT, only when Supabase rejects the refresh
//   token, never for a network failure. So every SIGNED_OUT the user did not ask for is a session
//   that ended, and shows Forced Logout (D-109).

let started = false;

export function startSessionSync(): void {
  if (started) {
    return;
  }
  started = true;

  if (userIdAtLaunch !== null) {
    useAuthStore.setState({ status: 'signedIn', userId: userIdAtLaunch });
  } else {
    // A logout the app died in the middle of can leave the last account's images on disk.
    void clearCachesQuietly();
  }

  supabase.auth.onAuthStateChange(handleAuthEvent);
  void reconcileAfterStartup();
}

async function handleAuthEvent(event: AuthChangeEvent, session: Session | null): Promise<void> {
  // auth-js awaits this callback and rethrows what it throws, which would make signOut reject
  // after the session is already gone, so nothing may escape.
  try {
    if (event === 'INITIAL_SESSION') {
      return;
    }
    if (event === 'SIGNED_OUT') {
      // Only the first SIGNED_OUT of a session decides anything. A second one arrives when the
      // API client signs out a session auth-js had already removed, and must not turn Forced
      // Logout into Login.
      if (useAuthStore.getState().status !== 'signedIn') {
        return;
      }
      useAuthStore.setState({
        status: isChosenLogout() ? 'signedOut' : 'sessionEnded',
        userId: null,
      });
      await clearAccountCaches();
      return;
    }
    // SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED and PASSWORD_RECOVERY all carry the live session.
    if (session !== null) {
      const previous = useAuthStore.getState().userId;
      useAuthStore.setState({ status: 'signedIn', userId: session.user.id });
      // A reset link for another account, opened while this one is signed in, swaps the session
      // with no logout between. The new account must not see the old one's caches.
      if (previous !== null && previous !== session.user.id) {
        await clearAccountCaches();
      }
    }
  } catch (error) {
    console.warn(`Handling the auth event ${event} failed`, error);
  }
}

// auth-js tells subscribers what startup did, but only the ones registered by then. This checks
// storage once startup is over, so a launch session removed during it shows Forced Logout even if
// its SIGNED_OUT went unheard. It judges only that session: after any other event, the event is
// the better witness.
async function reconcileAfterStartup(): Promise<void> {
  try {
    await supabase.auth.initialize();
  } catch (error) {
    console.warn('Supabase Auth failed to start', error);
  }
  const { status, userId } = useAuthStore.getState();
  if (
    status === 'signedIn' &&
    userIdAtLaunch !== null &&
    userId === userIdAtLaunch &&
    storedSessionUserId() === null
  ) {
    useAuthStore.setState({ status: 'sessionEnded', userId: null });
    await clearCachesQuietly();
  }
}

async function clearCachesQuietly(): Promise<void> {
  try {
    await clearAccountCaches();
  } catch (error) {
    console.warn('Clearing the account caches failed', error);
  }
}
