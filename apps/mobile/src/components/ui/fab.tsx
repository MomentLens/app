import { Platform, Pressable, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { useTokenColor } from '@/hooks/use-token-color';

interface FabProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  // Distance from the bottom of the screen's content area, so the caller can clear a tab bar that
  // lies over the content, as iOS's does.
  bottom: number;
}

// Material 3's FAB on Android is a 56dp square with 16dp corners and a 24dp icon, 16dp in from the
// edge, at elevation level 3, with a ripple (D-112). iOS before 26 gets the same button as a circle with
// a soft shadow, the shape iOS apps use; iOS 26 has the tab bar's button instead (lib/platform.ts).
//
// The gold takes dark content in both modes, as the primary Button does, since white on it fails
// contrast.
export function Fab({ icon, label, onPress, bottom }: FabProps) {
  const ripple = useTokenColor('textPrimary', 0.12);
  return (
    <View
      style={{ bottom, elevation: Platform.OS === 'android' ? 6 : undefined }}
      className="absolute right-4 h-14 w-14 bg-accent android:rounded-2xl ios:rounded-full ios:shadow-lg">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        android_ripple={{ color: ripple, foreground: true }}
        className="flex-1 items-center justify-center overflow-hidden android:rounded-2xl ios:rounded-full ios:active:bg-accentPressed">
        <Icon name={icon} size={24} className="text-textPrimary dark:text-background" />
      </Pressable>
    </View>
  );
}
