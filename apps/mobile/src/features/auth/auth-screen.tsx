import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface AuthScreenProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

// The frame every signed-out screen shares: a title, then the form, which scrolls clear of the
// keyboard. The keyboard settings are Expo's (docs.expo.dev/guides/keyboard-handling): padding on
// iOS, and on Android the view alone, because the window already resizes for the keyboard there.
export function AuthScreen({ title, subtitle, children }: AuthScreenProps) {
  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerClassName="flex-grow items-center justify-center px-6 py-10">
            <View className="w-full max-w-md gap-6">
              <View className="gap-2">
                <Text accessibilityRole="header" className="font-h1 text-h1 text-textPrimary">
                  {title}
                </Text>
                {subtitle ? (
                  <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {children}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
