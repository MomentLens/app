import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { MemberAvatar } from './member-avatar';

interface ActiveFilterPillProps {
  label: string;
  // A named person or uploader gets their avatar at the pill's start (16-event-home-album/02).
  avatarName?: string;
  onClear: () => void;
}

// One pill per active People or Uploader filter, above the grid, each with its own "×" (spec
// §2.5.2, D-176). They stack with the sub-event chip.
export function ActiveFilterPill({ label, avatarName, onClear }: ActiveFilterPillProps) {
  return (
    <View
      className={`flex-row items-center rounded-full border border-border bg-surfaceElevated py-1.5 pr-3 ${
        avatarName ? 'pl-1.5' : 'pl-3'
      }`}>
      {avatarName ? (
        <View className="mr-2">
          <MemberAvatar name={avatarName} size={24} />
        </View>
      ) : null}
      <Text className="mr-2 font-body text-caption text-textPrimary" numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Clear filter: ${label}`}
        hitSlop={12}
        onPress={onClear}
        className="h-4 w-4 items-center justify-center rounded-full bg-textSecondary/20">
        <Text className="text-[10px] font-bold text-textPrimary">✕</Text>
      </Pressable>
    </View>
  );
}

// The row the pills sit in, under the chip row. Two pills wrap onto a second line on a narrow
// phone rather than run off the edge.
export function ActiveFilterPills({ children }: { children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-2 px-4 pb-2">{children}</View>;
}
