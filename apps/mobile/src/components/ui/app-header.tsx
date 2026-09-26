import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';

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
      className={`h-11 w-11 justify-center ${disabled ? 'opacity-40' : ''}`}>
      <Icon name={icon} size={20} className="text-textPrimary" />
    </Pressable>
  );
}

// The strip at the top of every signed-in screen in the Figma frames: an action on the left, the
// aperture mark and wordmark in the middle, and the avatar or nothing on the right.
export function AppHeader({ left, right }: AppHeaderProps) {
  return (
    <View className="h-11 flex-row items-center justify-between">
      {left ? <Action {...left} /> : <View className="h-11 w-11" />}
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel="MomentLens"
        className="flex-row items-center gap-1.5">
        <Icon name="aperture" size={16} className="text-accent" />
        <Text className="font-micro text-micro uppercase tracking-widest text-textPrimary">
          MomentLens
        </Text>
      </View>
      <View className="h-11 w-11 items-end justify-center">{right}</View>
    </View>
  );
}
