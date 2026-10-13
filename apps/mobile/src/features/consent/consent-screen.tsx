import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Glyph } from '@/components/ui/glyph';
import { AuthScreen, Inset } from '@/features/auth/auth-screen';
import { logout } from '@/features/auth/logout';
import { ApiError } from '@/lib/api';
import { byPlatform } from '@/lib/copy';
import { useAuthStore } from '@/stores/auth';

import { acceptCurrentConsent } from './accept';
import { CONSENT_FOOTNOTE, CONSENT_INTRO, CONSENT_SECTIONS, CONSENT_TITLE } from './text';
import { useConsentGate } from './use-consent-gate';

// What the person reads when Agree fails. Accepting needs a connection and is never queued
// (spec §4.18).
function acceptProblem(error: unknown): string {
  if (error instanceof ApiError && error.status !== undefined) {
    return error.status === 401
      ? 'Your sign-in could not be confirmed. Try again.'
      : 'Something went wrong on our side. Try again in a moment.';
  }
  return 'Agreeing needs a connection. Check it and try again.';
}

// The consent screen, right after signup and before anything else renders, and again at launch
// when the version changes (spec §2.5.8, §4.18, D-161). It blocks the whole signed-in app: the
// root layout opens nothing else until the gate says accepted. Log Out is the way off it for
// someone who will not agree, on a phone the team hands around.
export function ConsentScreen() {
  const userId = useAuthStore((state) => state.userId);
  const gate = useConsentGate(userId);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function agree() {
    if (userId === null || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      // The gate turns accepted, and the root layout swaps this route for the app.
      await acceptCurrentConsent(userId);
    } catch (error) {
      if (useAuthStore.getState().userId === userId) setProblem(acceptProblem(error));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setLeaving(true);
    await logout();
  }

  // Nothing kept on this phone and the server not asked yet: a moment's wait rather than the text
  // or the app.
  if (gate === 'checking' || gate === null) {
    return (
      <AuthScreen variant="status" title="Checking your account">
        <ActivityIndicator className="text-accent" />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={CONSENT_TITLE}
      subtitle={CONSENT_INTRO}
      footer={
        <>
          {problem ? <FormMessage message={problem} /> : null}
          <Button
            label={byPlatform('Agree and Continue', 'Agree and continue')}
            busy={busy}
            disabled={leaving}
            onPress={() => void agree()}
          />
          <Button
            label={byPlatform('Log Out', 'Log out')}
            variant="quiet"
            busy={leaving}
            disabled={busy}
            onPress={() => void leave()}
          />
        </>
      }>
      <Inset>
        <View className="gap-6 pt-2">
          {CONSENT_SECTIONS.map((section) => (
            <View key={section.key} className="flex-row gap-4">
              <View className="w-8 items-center pt-0.5">
                <Glyph name={section.glyph} size={26} tone="accentText" />
              </View>
              <View className="flex-1 gap-1">
                <Text accessibilityRole="header" className="font-h2 text-body text-textPrimary">
                  {section.title}
                </Text>
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  {section.body}
                </Text>
              </View>
            </View>
          ))}
          <Text className="font-caption text-caption text-textSecondary">{CONSENT_FOOTNOTE}</Text>
        </View>
      </Inset>
    </AuthScreen>
  );
}
