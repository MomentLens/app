import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandHeader } from '@/components/ui/brand-header';
import { Icon, type IconName } from '@/components/ui/icon';

interface AuthScreenProps {
  title: string;
  // The small gold line under Login's title.
  tagline?: string;
  subtitle?: string;
  // The round badge above the title, as on Check your email.
  icon?: IconName;
  onBack?: () => void;
  // Pinned to the bottom of the screen, for the frames whose one action sits there.
  footer?: ReactNode;
  children?: ReactNode;
}

// The frame every signed-out screen shares, laid out as in the Figma login flow: the brand header,
// a centred title, the content below it, and an optional action pinned to the bottom. The content
// scrolls clear of the keyboard with Expo's settings (docs.expo.dev/guides/keyboard-handling):
// padding on iOS, and on Android the view alone, because the window resizes for the keyboard there.
export function AuthScreen({
  title,
  tagline,
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
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}>
          <View className="px-6">
            <BrandHeader onBack={onBack} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="flex-grow px-6 pb-6 pt-10">
            <View className="w-full max-w-md gap-6 self-center">
              {icon ? (
                <View className="h-20 w-20 items-center justify-center self-center rounded-full bg-accentTint">
                  <Icon name={icon} size={32} className="text-accent" />
                </View>
              ) : null}
              <View className="items-center gap-2">
                <Text
                  accessibilityRole="header"
                  className="text-center font-h1 text-h1 text-textPrimary">
                  {title}
                </Text>
                {tagline ? (
                  <Text className="font-micro text-micro uppercase tracking-widest text-accentText">
                    {tagline}
                  </Text>
                ) : null}
                {subtitle ? (
                  <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {children}
            </View>
          </ScrollView>
          {/* The padding sits outside the width cap, as the scrolling content's does, so the
              footer lines up with the fields on a phone narrower or wider than the cap. */}
          {footer ? (
            <View className="px-6 pb-4 pt-2">
              <View className="w-full max-w-md gap-2 self-center">{footer}</View>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
