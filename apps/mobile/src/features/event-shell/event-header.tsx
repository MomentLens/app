import type { ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { HEADER_BAR, HEADER_ICON_SIZE, HEADER_SLOT } from '@/components/ui/app-header';
import { Icon } from '@/components/ui/icon';

interface EventHeaderProps {
  // Left out while the event is loading or out of reach, which leaves the bar and its way back.
  name?: string;
  onBack: () => void;
  // S-29 puts the caller's avatar here, which opens Account Settings (spec §2.5.9).
  right?: ReactNode;
}

// iOS writes where back goes beside the chevron, as its own back button does. Material 3's top app
// bar has an icon alone, in a 48dp button like every other header action here (D-112).
function BackToEvents({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to Events"
      hitSlop={8}
      onPress={onPress}
      className="flex-row items-center gap-1 ios:h-11 ios:pr-2 android:h-12 android:w-12 ios:active:opacity-40">
      <Icon name="chevron-left" size={HEADER_ICON_SIZE} className="text-textPrimary" />
      {Platform.OS === 'ios' ? (
        <Text className="font-body text-body text-textPrimary">Events</Text>
      ) : null}
    </Pressable>
  );
}

// The Event shell's persistent header, above every tab (spec §2.5.1, hb §16.5): the way back to
// Events, the event's name, and S-29's slot. Each platform's bar sizes it (D-112). It shows no cover:
// the name says which event this is, and the Figma frames leave the cover out (D-119). The name
// stays on one line, so an 80-character one ends in an ellipsis (D-110).
export function EventHeader({ name, onBack, right }: EventHeaderProps) {
  return (
    <View className="gap-1 bg-background px-4 pb-3">
      <View className={`flex-row items-center justify-between ${HEADER_BAR}`}>
        <BackToEvents onPress={onBack} />
        <View className={`${HEADER_SLOT} items-end justify-center`}>{right}</View>
      </View>
      {name !== undefined ? (
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          className="font-h1 text-h1 text-textPrimary">
          {name}
        </Text>
      ) : null}
    </View>
  );
}
