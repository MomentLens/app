import { Stack, type NativeStackHeaderItem, type NativeStackNavigationOptions } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';

import type { BarAction, LargeTitleScreenProps } from '@/components/ui/large-title-screen.types';
import { useTokenColor } from '@/hooks/use-token-color';

function barItem(action: BarAction): NativeStackHeaderItem {
  return {
    type: 'button',
    label: action.text ?? action.label,
    accessibilityLabel: action.label,
    icon:
      action.text === undefined && action.glyph?.ios
        ? { type: 'sfSymbol', name: action.glyph.ios }
        : undefined,
    disabled: action.disabled,
    onPress: action.onPress,
  };
}

// A tab's first screen on iOS: UIKit's own navigation bar, with a large title in Fraunces that
// collapses into the bar as the content scrolls, and native bar buttons, which iOS 26 draws on
// Liquid Glass (D-125). The screen has to sit in a Stack, which is why every tab has one.
export function LargeTitleScreen({
  title,
  subtitle,
  back,
  actions = [],
  trailing,
  refreshControl,
  bottomInset = 0,
  overlay,
  contentClassName = '',
  children,
}: LargeTitleScreenProps) {
  const text = useTokenColor('textPrimary');
  const background = useTokenColor('background');

  const right: NativeStackHeaderItem[] = actions.map(barItem);
  if (trailing) {
    right.push({ type: 'custom', element: trailing });
  }

  const options: NativeStackNavigationOptions = {
    headerShown: true,
    title,
    headerLargeTitleEnabled: true,
    headerTransparent: true,
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    headerLargeTitleStyle: { fontFamily: 'Fraunces_600SemiBold', color: text },
    headerTitleStyle: { color: text },
    headerTintColor: text,
    contentStyle: { backgroundColor: background },
    unstable_headerLeftItems: back
      ? () => [
          {
            type: 'button',
            label: back.label,
            accessibilityLabel: back.label,
            icon: { type: 'sfSymbol', name: 'chevron.backward' },
            onPress: back.onPress,
          },
        ]
      : undefined,
    unstable_headerRightItems: right.length > 0 ? () => right : undefined,
  };

  return (
    <>
      <Stack.Screen options={options} />
      {/* "automatic" lets UIKit inset the content under the bar and above the tab bar, and is
          what makes the large title collapse as the content scrolls. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={refreshControl}
        className="flex-1 bg-background"
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}>
        {subtitle ? (
          <View className="px-5 pb-2">
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              {subtitle}
            </Text>
          </View>
        ) : null}
        <View className={contentClassName}>{children}</View>
      </ScrollView>
      {overlay}
    </>
  );
}
