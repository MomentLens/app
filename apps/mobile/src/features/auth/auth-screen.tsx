import type { ReactNode } from 'react';
import { KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/ui/back-button';
import { Icon, type IconName } from '@/components/ui/icon';

interface AuthScreenProps {
  title: string;
  // brand is Login: the mark, the wordmark and one line, with no bar. titled is a form under a
  // large title. status is a centred message, such as Check Your Email or Join Error.
  variant?: 'brand' | 'titled' | 'status';
  subtitle?: string;
  // The neutral glyph above a status title.
  icon?: IconName;
  onBack?: () => void;
  // Pinned to the bottom of the screen, in thumb reach, for the screen's actions.
  footer?: ReactNode;
  children?: ReactNode;
}

// The frame the signed-out screens and the join and status screens share (D-124, D-125). Login
// keeps the brand; every other screen gets the platform's back button and a plain title, with no
// wordmark. Sections inside lay out their own margins; anything else goes in an Inset. The content
// scrolls clear of the keyboard with padding on both platforms, because the app draws edge to edge
// and Android no longer shrinks the window for the keyboard.
export function AuthScreen({
  title,
  variant = 'titled',
  subtitle,
  icon,
  onBack,
  footer,
  children,
}: AuthScreenProps) {
  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          {variant !== 'brand' ? (
            <View className="h-14 flex-row items-center ios:px-4 android:px-1">
              {onBack ? <BackButton onPress={onBack} /> : null}
            </View>
          ) : null}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName={`flex-grow gap-6 pb-6 ${variant === 'status' ? 'justify-center' : ''}`}>
            {variant === 'brand' ? (
              <Brand subtitle={subtitle} />
            ) : variant === 'status' ? (
              <Status title={title} subtitle={subtitle} icon={icon} />
            ) : (
              <Inset>
                <View className="gap-2 pt-2">
                  <Text
                    accessibilityRole="header"
                    className="font-title text-title text-textPrimary">
                    {title}
                  </Text>
                  {subtitle ? (
                    <Text className="font-body text-body text-textSecondary">{subtitle}</Text>
                  ) : null}
                </View>
              </Inset>
            )}
            {children}
          </ScrollView>
          {footer ? <View className="gap-3 pb-2 pt-3 ios:px-5 android:px-6">{footer}</View> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

// The page margin for content that is not a grouped section, which brings its own.
export function Inset({ children }: { children: ReactNode }) {
  return <View className="ios:px-5 android:px-6">{children}</View>;
}

// Login's lockup: the aperture mark, the name in Fraunces, and what the app does. The wordmark
// appears here and on the launch screen, nowhere else (D-124).
function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`MomentLens. ${subtitle ?? ''}`}
      className="items-center gap-3 px-8 pt-16">
      <Icon name="aperture" size={56} className="text-accent" />
      <Text className="font-display text-display text-textPrimary">MomentLens</Text>
      {subtitle ? (
        <Text className="text-center font-body text-body text-textSecondary">{subtitle}</Text>
      ) : null}
    </View>
  );
}

// A message on its own, with a neutral glyph rather than the gold, which marks the brand and the
// primary action only (D-124).
function Status({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: IconName }) {
  return (
    <View className="items-center gap-3 px-8">
      {icon ? (
        <View className="mb-2 h-16 w-16 items-center justify-center rounded-full bg-textPrimary/5">
          <Icon name={icon} size={28} className="text-textSecondary" />
        </View>
      ) : null}
      <Text accessibilityRole="header" className="text-center font-h1 text-h1 text-textPrimary">
        {title}
      </Text>
      {subtitle ? (
        <Text className="text-center font-body text-body text-textSecondary">{subtitle}</Text>
      ) : null}
    </View>
  );
}
