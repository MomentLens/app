import { Pressable, Text, View } from 'react-native';

interface ActiveFilterPillProps {
  label: string;
  onClear: () => void;
}

// Active-filter pill renders above the grid when an Uploader filter is active (spec §2.5.2).
// Shows its own "×" button to dismiss the filter.
export function ActiveFilterPill({ label, onClear }: ActiveFilterPillProps) {
  return (
    <View className="px-4 pb-2">
      <View className="flex-row items-center self-start rounded-full border border-border bg-surfaceElevated px-3 py-1.5">
        <Text className="mr-2 font-body text-caption text-textPrimary">{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear filter"
          hitSlop={8}
          onPress={onClear}
          className="h-4 w-4 items-center justify-center rounded-full bg-textSecondary/20">
          <Text className="text-[10px] font-bold text-textPrimary">✕</Text>
        </Pressable>
      </View>
    </View>
  );
}
