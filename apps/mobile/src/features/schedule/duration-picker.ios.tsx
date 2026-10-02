import { Picker } from '@expo/ui';
import { View } from 'react-native';

import { TintedHost } from '@/components/ui/tinted-host';
import { MINUTE_STEP } from '@/features/events/time';
import type { DurationPickerProps } from '@/features/schedule/duration-picker.types';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);

// A custom Delay on iOS: SwiftUI's wheels for hours and minutes, side by side, as the Clock app's
// timer has them (D-127).
export function DurationPicker({ minutes, onChange }: DurationPickerProps) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return (
    <View className="flex-row" accessibilityLabel="Delay by">
      <TintedHost matchContents={{ vertical: true }} style={{ flex: 1 }} className="text-accent">
        <Picker
          appearance="wheel"
          selectedValue={hours}
          onValueChange={(next) => onChange(next * 60 + rest)}>
          {HOURS.map((value) => (
            <Picker.Item
              key={value}
              value={value}
              label={`${value} ${value === 1 ? 'hour' : 'hours'}`}
            />
          ))}
        </Picker>
      </TintedHost>
      <TintedHost matchContents={{ vertical: true }} style={{ flex: 1 }} className="text-accent">
        <Picker
          appearance="wheel"
          selectedValue={rest}
          onValueChange={(next) => onChange(hours * 60 + next)}>
          {MINUTES.map((value) => (
            <Picker.Item key={value} value={value} label={`${value} min`} />
          ))}
        </Picker>
      </TintedHost>
    </View>
  );
}
