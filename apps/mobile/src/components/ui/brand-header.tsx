import { Pressable, View } from 'react-native';

import { HEADER_BAR, HEADER_ICON_SIZE, Wordmark } from '@/components/ui/app-header';
import { Icon } from '@/components/ui/icon';

interface BrandHeaderProps {
  // Shows a back chevron on the left when set.
  onBack?: () => void;
}

// The bar at the top of every signed-out screen: the wordmark, centred, with an optional back
// chevron. Same height and sizes as the signed-in AppHeader.
export function BrandHeader({ onBack }: BrandHeaderProps) {
  return (
    <View className={`flex-row items-center justify-center ${HEADER_BAR}`}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          onPress={onBack}
          className="absolute left-0 justify-center ios:h-11 ios:w-11 android:h-12 android:w-12">
          <Icon name="chevron-left" size={HEADER_ICON_SIZE} className="text-textPrimary" />
        </Pressable>
      ) : null}
      <Wordmark />
    </View>
  );
}
