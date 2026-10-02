import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/ui/back-button';
import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { byPlatform } from '@/lib/copy';

export const WIZARD_STEPS = 3;

interface WizardAction {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}

interface WizardFrameProps {
  step: 1 | 2 | 3;
  // Close on step 1, which asks before discarding the draft, and back on the others.
  leading: { kind: 'close' | 'back'; label: string; onPress: () => void; disabled?: boolean };
  // The step's main action, Next or Create Event.
  primary: WizardAction;
  // A second action: Android's Back beside Next, or Skip Cover once a cover has failed.
  secondary?: WizardAction;
  children: ReactNode;
}

// The frame the three Create Event steps share (spec §2.1.2, D-111): a bar titled "New Event"
// with the step under it, a thin progress bar, the step's grouped form, and its actions at the foot
// (D-124, D-125). iOS puts the main action full width; Android puts Back and Next in a bottom bar,
// as Material 3's steppers do. The content scrolls clear of the keyboard on both platforms.
export function WizardFrame({ step, leading, primary, secondary, children }: WizardFrameProps) {
  // The insets come from the root provider rather than a SafeAreaView, which measures zero inside
  // the full-screen modal the wizard is presented in and put the header under the status bar.
  const insets = useSafeAreaInsets();
  const ios = Platform.OS === 'ios';
  const title = byPlatform('New Event', 'New event');

  return (
    <View
      className="flex-1 bg-background"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      {/* Padding on Android too. The app draws edge to edge there, so Android no longer shrinks
          the window for the keyboard, and with no behavior the keyboard covered the lower fields
          and left nothing to scroll. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {ios ? (
          <View className="h-14 flex-row items-center justify-between px-4">
            {leading.kind === 'close' ? (
              <GlassButton
                label={leading.label}
                onPress={leading.onPress}
                disabled={leading.disabled}>
                <Glyph name={GLYPH.close} size={18} tone="textPrimary" />
              </GlassButton>
            ) : (
              <BackButton label={leading.label} onPress={leading.onPress} />
            )}
            <View accessible accessibilityRole="header" className="items-center">
              <Text className="font-h2 text-body text-textPrimary">{title}</Text>
              <Text className="font-caption text-caption text-textSecondary">
                Step {step} of {WIZARD_STEPS}
              </Text>
            </View>
            <View className="w-11" />
          </View>
        ) : (
          <View className="h-16 flex-row items-center gap-1 px-1">
            <BarIconButton
              glyph={leading.kind === 'close' ? GLYPH.close : GLYPH.back}
              label={leading.label}
              onPress={leading.onPress}
              disabled={leading.disabled}
            />
            <View accessible accessibilityRole="header" className="flex-1 px-1">
              <Text className="font-h2 text-h2 text-textPrimary">{title}</Text>
              <Text className="font-caption text-caption text-textSecondary">
                Step {step} of {WIZARD_STEPS}
              </Text>
            </View>
          </View>
        )}
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`Step ${step} of ${WIZARD_STEPS}`}
          accessibilityValue={{ min: 1, max: WIZARD_STEPS, now: step }}
          className="flex-row gap-1.5 ios:px-5 android:px-4">
          {Array.from({ length: WIZARD_STEPS }, (_, i) => (
            <View
              key={i}
              className={`h-1 flex-1 rounded-full ${i < step ? 'bg-accent' : 'bg-textPrimary/10'}`}
            />
          ))}
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-6 pb-8 pt-5">
          {children}
        </ScrollView>
        {ios ? (
          <View className="gap-3 px-5 pb-2 pt-3">
            {secondary ? (
              <Button
                label={secondary.label}
                variant="secondary"
                busy={secondary.busy}
                disabled={secondary.disabled}
                onPress={secondary.onPress}
              />
            ) : null}
            <Button
              label={primary.label}
              busy={primary.busy}
              disabled={primary.disabled}
              onPress={primary.onPress}
            />
          </View>
        ) : (
          <View className="flex-row items-center justify-between gap-3 bg-surfaceContainer px-4 py-3">
            {secondary ? (
              <Button
                label={secondary.label}
                variant="quiet"
                size="small"
                busy={secondary.busy}
                disabled={secondary.disabled}
                onPress={secondary.onPress}
              />
            ) : (
              <View />
            )}
            <Button
              label={primary.label}
              size="small"
              busy={primary.busy}
              disabled={primary.disabled}
              onPress={primary.onPress}
            />
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

// A field's error line, announced when it appears.
export function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <Text accessibilityLiveRegion="polite" className="px-4 font-caption text-caption text-danger">
      {message}
    </Text>
  );
}
