import { Image } from 'expo-image';

import { queryClient } from '@/lib/query-client';
import { removeStoredSession, storedSessionUserId, supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';

// True only while logout() is signing out, so the SIGNED_OUT that auth-js sends during it reads as
// a choice, and every other SIGNED_OUT as a session that ended (features/auth/session.ts).
let chosenLogoutInProgress = false;

export function isChosenLogout(): boolean {
  return chosenLogoutInProgress;
}

// Everything one account left in memory or on disk that the next account must not see. The team
// hands phones around, and expo-image's disk cache holds the last account's images, the unblurred
// ones included (apps/mobile/CLAUDE.md, spec §4.1). The upload queue is per account already and is
// not touched.
export async function clearAccountCaches(): Promise<void> {
  // A query still in flight would otherwise land in the cache after it was cleared.
  await queryClient.cancelQueries();
  queryClient.clear();
  await Promise.all([Image.clearMemoryCache(), Image.clearDiskCache()]);
}

// The user's own logout, which goes to Login. It signs out this device only, so the account's
// other device stays signed in (D-109, spec §4.1), and resolves once the caches are clear.
export async function logout(): Promise<void> {
  chosenLogoutInProgress = true;
  try {
    // auth-js removes the stored session and sends SIGNED_OUT even when it cannot reach Supabase
    // to revoke it. session.ts moves the app to Login and clears the caches in response.
    await supabase.auth.signOut({ scope: 'local' });
  } catch (error) {
    // Still logged out: the check below removes whatever is left.
    console.warn('signOut failed', error);
  } finally {
    chosenLogoutInProgress = false;
  }

  // auth-js 2.116.0 returns without removing anything when it cannot load the session first,
  // which is what happens offline once the access token has expired. A logout the user asked for
  // must work offline too, on a shared phone most of all.
  if (storedSessionUserId() !== null) {
    removeStoredSession();
  }
  if (useAuthStore.getState().status === 'signedIn') {
    useAuthStore.setState({ status: 'signedOut', userId: null });
    await clearAccountCaches();
  }
}
