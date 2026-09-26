import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, type HeaderAction } from '@/components/ui/app-header';

export const WIZARD_STEPS = 3;

interface WizardFrameProps {
  step: 1 | 2 | 3;
  title: string;
  back: HeaderAction;
  // Pinned under the content, for the step's Next or Create button.
  footer: ReactNode;
  children: ReactNode;
}

// The frame the three Create Event steps share, laid out as in the Figma wizard frames: the header,
// a three-part progress bar, "STEP n OF 3", the title, the content, and the step's button pinned at
// the bottom (spec §2.1.2, D-111). The content scrolls clear of the keyboard with Expo's settings,
// as the auth screens do.
export function WizardFrame({ step, title, back, footer, children }: WizardFrameProps) {
  // The insets come from the root provider rather than a SafeAreaView, which measures zero inside
  // the full-screen modal the wizard is presented in and put the header under the status bar.
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-1 bg-background"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}>
        <View className="gap-4 px-4">
          <AppHeader left={back} />
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={`Step ${step} of ${WIZARD_STEPS}`}
            accessibilityValue={{ min: 1, max: WIZARD_STEPS, now: step }}
            className="flex-row gap-2">
            {Array.from({ length: WIZARD_STEPS }, (_, i) => (
              <View
                key={i}
                className={`h-1 flex-1 rounded-full ${i < step ? 'bg-accent' : 'bg-border'}`}
              />
            ))}
          </View>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-5 px-4 pb-6 pt-6">
          <View className="gap-1">
            <Text className="font-micro text-micro uppercase tracking-wider text-textSecondary">
              Step {step} of {WIZARD_STEPS}
            </Text>
            <Text accessibilityRole="header" className="font-h1 text-h1 text-textPrimary">
              {title}
            </Text>
          </View>
          {children}
        </ScrollView>
        <View className="gap-3 border-t border-border bg-background px-4 pb-2 pt-3">{footer}</View>
      </KeyboardAvoidingView>
    </View>
  );
}

// A field's label as the other form fields draw it, for the controls TextField does not cover.
export function FieldLabel({ children }: { children: string }) {
  return (
    <Text className="font-micro text-micro uppercase tracking-wider text-textSecondary">
      {children}
    </Text>
  );
}

// A field's error line, announced when it appears.
export function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
      {message}
    </Text>
  );
}
