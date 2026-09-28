import type { ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';

// Each platform's own bar (D-112). iOS: a 44pt navigation bar with 44pt buttons and 22pt glyphs.
// Android: Material 3's 64dp top app bar with 48dp icon buttons and 24dp icons.
export const HEADER_ICON_SIZE = Platform.OS === 'ios' ? 22 : 24;
const MARK_SIZE = Platform.OS === 'ios' ? 20 : 22;
// The avatar at the bar's trailing end, as the Events tab draws it.
export const HEADER_AVATAR_SIZE = Platform.OS === 'ios' ? 36 : 32;

// The bar's height, and the square each button in it takes. Tailwind finds these classes here.
export const HEADER_BAR = 'ios:h-11 android:h-16';
const SLOT = 'ios:h-11 ios:w-11 android:h-12 android:w-12';

export interface HeaderAction {
  icon: IconName;
  label: string;
  onPress?: () => void;
  // Drawn but not pressable, for a placeholder whose slice has not landed yet.
  disabled?: boolean;
}

interface AppHeaderProps {
  left?: HeaderAction;
  right?: ReactNode;
}

function Action({ icon, label, onPress, disabled = false }: HeaderAction) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled || onPress === undefined}
      hitSlop={8}
      onPress={onPress}
      className={`${SLOT} justify-center ${disabled ? 'opacity-40' : ''}`}>
      <Icon name={icon} size={HEADER_ICON_SIZE} className="text-textPrimary" />
    </Pressable>
  );
}

// The aperture mark and the wordmark, which every header centres, signed in or out.
export function Wordmark() {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel="MomentLens"
      className="flex-row items-center gap-2">
      <Icon name="aperture" size={MARK_SIZE} className="text-accent" />
      <Text className="font-wordmark text-wordmark uppercase tracking-widest text-textPrimary">
        MomentLens
      </Text>
    </View>
  );
}

// The bar at the top of every signed-in screen: an action on the left, the wordmark in the middle,
// and the avatar or nothing on the right. The Figma frames set the layout; the sizes are each
// platform's.
export function AppHeader({ left, right }: AppHeaderProps) {
  return (
    <View className={`flex-row items-center justify-between ${HEADER_BAR}`}>
      {left ? <Action {...left} /> : <View className={SLOT} />}
      <Wordmark />
      <View className={`${SLOT} items-end justify-center`}>{right}</View>
    </View>
  );
}
