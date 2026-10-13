import { useEffect } from 'react';
import { useMMKVNumber } from 'react-native-mmkv';

import { useMyProfile } from '@/hooks/use-my-profile';

import {
  consentGate,
  consentStorage,
  keptConsentKey,
  reconcileConsent,
  type ConsentGate,
} from './gate';

// The consent gate for the signed-in account, or null with nobody signed in. The root layout reads
// it to choose between the consent route and the signed-in app, and the consent route to choose
// between its spinner and its text. Each answer from GET /profiles/me updates the kept answer, so
// an account that accepted on another phone opens offline here next time (D-161).
export function useConsentGate(userId: string | null): ConsentGate | null {
  // A key no account has while nobody is signed in, since a hook cannot be skipped.
  const [kept] = useMMKVNumber(keptConsentKey(userId ?? ''), consentStorage);
  const profile = useMyProfile({ enabled: userId !== null });
  const data = profile.data;

  useEffect(() => {
    if (userId !== null && data !== undefined) reconcileConsent(userId, data);
  }, [userId, data]);

  if (userId === null) return null;
  return consentGate(userId, kept, { data, failed: profile.isError });
}
