import { PRIVACY_POLICY_VERSION, type ProfileResponse } from '@momentlens/shared-types';

import { PROFILE_QUERY_KEY } from '@/hooks/use-my-profile';
import { acceptConsent } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

import { keepConsent } from './gate';

// Records that `owner` accepted the current version, then opens the app (D-161). The POST goes out
// only under `owner`'s session and needs a connection; a failure keeps nothing, and the screen
// stays up with its error.
//
// A profile fetch already in flight may have left the server before the row existed, and would land
// with consentRequired still true and close the app again. So any such fetch is cancelled once the
// POST has answered, the cached profile is marked accepted, and a fresh fetch confirms it.
export async function acceptCurrentConsent(owner: string): Promise<void> {
  await acceptConsent(owner, { policyVersion: PRIVACY_POLICY_VERSION });
  // A late answer must not cancel the next account's profile request.
  if (useAuthStore.getState().userId !== owner) return;
  await queryClient.cancelQueries({ queryKey: PROFILE_QUERY_KEY, exact: true });
  if (useAuthStore.getState().userId !== owner) return;
  queryClient.setQueryData<ProfileResponse>(PROFILE_QUERY_KEY, (profile) =>
    profile?.userId === owner ? { ...profile, consentRequired: false } : profile,
  );
  keepConsent(owner);
  void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY, exact: true });
}
