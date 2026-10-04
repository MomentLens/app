import { Stack, type NativeStackNavigationOptions } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, ScrollView } from 'react-native';

import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import type { SettingsFrameProps } from '@/features/manage/settings-frame.types';
import { useTokenColor } from '@/hooks/use-token-color';

// Event Settings' frame on iOS: UIKit's own navigation bar with the title inline, the native back
// button as a chevron, and Save as a checkmark at the trailing end (D-125). The checkmark is the
// sheets' own done button, gold with a dark glyph, because the native prominent item draws a white
// glyph that fails contrast on the gold. It turns plain glass while there is nothing to save.
export function SettingsFrame({ title, save, children }: SettingsFrameProps) {
  const { colorScheme } = useColorScheme();
  const text = useTokenColor('textPrimary');
  const background = useTokenColor('background');
  const accent = useTokenColor('accent');
  const onGold = colorScheme === 'dark' ? 'background' : 'textPrimary';
  const { label, disabled, busy } = save;
  const tinted = !disabled;

  // The screen hands a new onPress every render, one per keystroke in a field. Read through a ref,
  // it leaves the options alone, and Stack.Screen sets them on the native bar again only when
  // Save's label or state changes.
  const onPress = useRef(save.onPress);
  useLayoutEffect(() => {
    onPress.current = save.onPress;
  });

  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      headerShown: true,
      title,
      headerTransparent: true,
      headerShadowVisible: false,
      headerTitleStyle: { color: text },
      headerTintColor: text,
      headerBackButtonDisplayMode: 'minimal',
      contentStyle: { backgroundColor: background },
      unstable_headerRightItems: () => [
        {
          type: 'custom',
          hidesSharedBackground: true,
          element: (
            <GlassButton
              label={label}
              onPress={() => onPress.current()}
              disabled={disabled || busy}
              tint={tinted ? accent : undefined}>
              {busy ? (
                <ActivityIndicator className="text-textPrimary dark:text-background" />
              ) : (
                <Glyph name={GLYPH.check} size={18} tone={tinted ? onGold : 'textPrimary'} />
              )}
            </GlassButton>
          ),
        },
      ],
    }),
    [title, text, background, accent, onGold, label, disabled, busy, tinted],
  );

  return (
    <>
      <Stack.Screen options={options} />
      {/* "automatic" insets the form under the transparent bar and above the tab bar, and the
          keyboard inset keeps the field being typed in above the keyboard. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        className="flex-1 bg-background"
        contentContainerClassName="gap-6 pb-10 pt-3">
        {children}
      </ScrollView>
    </>
  );
}
