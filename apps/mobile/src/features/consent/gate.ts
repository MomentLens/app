import { PRIVACY_POLICY_VERSION, type ProfileResponse } from '@momentlens/shared-types';
import { createMMKV } from 'react-native-mmkv';

import { PROFILE_QUERY_KEY } from '@/hooks/use-my-profile';
import { queryClient } from '@/lib/query-client';

// The consent gate (spec §4.18, D-161). The app enforces it and the API does not.
//
// - accepted: the signed-in app renders.
// - required: the consent screen shows its text.
// - checking: nothing is kept on this phone and GET /profiles/me has not answered yet, so the
//   consent route shows a spinner rather than the text or the app.
export type ConsentGate = 'accepted' | 'required' | 'checking';

// Each account's last answer, kept on the phone so an offline launch that accepted the current
// version opens (spec §4.14). Keyed by account, because the team hands phones around: a second
// account on the phone never inherits the first one's yes. A logout leaves it, since the answer
// is still that account's.
export const consentStorage = createMMKV({ id: 'consent' });

export function keptConsentKey(userId: string): string {
  return `accepted:${userId}`;
}

export function readKeptConsent(userId: string): number | undefined {
  return consentStorage.getNumber(keptConsentKey(userId));
}

export function keepConsent(userId: string): void {
  consentStorage.set(keptConsentKey(userId), PRIVACY_POLICY_VERSION);
}

interface ProfileState {
  data: ProfileResponse | undefined;
  // True once the profile query has failed, offline included.
  failed: boolean;
}

// The server's answer decides once there is one for this account. Before that a kept answer for
// the current version opens the app; an older version, or none, waits for the server, and shows the
// screen when the server cannot be asked. Accepting then needs a connection.
export function consentGate(
  userId: string,
  kept: number | undefined,
  profile: ProfileState,
): ConsentGate {
  const answer = profile.data?.userId === userId ? profile.data : undefined;
  if (answer) return answer.consentRequired ? 'required' : 'accepted';
  if (kept === PRIVACY_POLICY_VERSION) return 'accepted';
  return profile.failed ? 'required' : 'checking';
}

// Brings the kept answer in line with an answer from GET /profiles/me: kept when the server has
// this version recorded, from this phone or another, and dropped when it does not.
export function reconcileConsent(userId: string, profile: ProfileResponse): void {
  if (profile.userId !== userId) return;
  if (!profile.consentRequired) {
    if (readKeptConsent(userId) !== PRIVACY_POLICY_VERSION) keepConsent(userId);
  } else if (readKeptConsent(userId) !== undefined) {
    consentStorage.remove(keptConsentKey(userId));
  }
}

// The gate outside React, for following an invite link (features/join/follow-invite.ts).
export function currentConsentGate(userId: string): ConsentGate {
  const state = queryClient.getQueryState<ProfileResponse>(PROFILE_QUERY_KEY);
  return consentGate(userId, readKeptConsent(userId), {
    data: state?.data,
    failed: state?.status === 'error',
  });
}
