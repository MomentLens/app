import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';

interface BrandHeaderProps {
  // Shows a back chevron on the left when set.
  onBack?: () => void;
}

// The strip at the top of every signed-out screen in the Figma frames: the aperture mark and the
// wordmark, centred, with an optional back chevron.
export function BrandHeader({ onBack }: BrandHeaderProps) {
  return (
    <View className="h-11 flex-row items-center justify-center">
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          onPress={onBack}
          className="absolute left-0 h-11 w-11 justify-center">
          <Icon name="chevron-left" size={22} className="text-textPrimary" />
        </Pressable>
      ) : null}
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
    </View>
  );
}
