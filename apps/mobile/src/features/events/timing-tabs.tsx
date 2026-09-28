import type { EventTiming } from '@momentlens/shared-types';
import { Pressable, Text, View } from 'react-native';

const TABS: { value: EventTiming; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
];

interface TimingTabsProps {
  value: EventTiming;
  onChange: (value: EventTiming) => void;
}

// Each segment is drawn 36pt tall on iOS and 40dp on Android, Material 3's segmented button, and
// reaches 4 past its edges into the track's padding, so the target is 44pt or 48dp (D-112).
const SEGMENT_SLOP = { top: 4, bottom: 4 };

// The Events tab's Active / Upcoming / Past control (spec §2.5.1), a pill track as in the Figma
// frame. A screen reader reads it as three tabs with the chosen one selected.
export function TimingTabs({ value, onChange }: TimingTabsProps) {
  return (
    <View accessibilityRole="tablist" className="flex-row rounded-full bg-surfaceMuted p-1">
      {TABS.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.value)}
            hitSlop={SEGMENT_SLOP}
            className={`flex-1 items-center justify-center rounded-full ios:min-h-9 android:min-h-10 ${selected ? 'bg-accentTint' : ''}`}>
            <Text
              className={`font-fieldLabel text-fieldLabel ${selected ? 'text-accentText' : 'text-textSecondary'}`}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
