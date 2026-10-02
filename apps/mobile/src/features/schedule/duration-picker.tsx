import { DateTimePicker } from '@expo/ui/jetpack-compose';

import { TintedHost } from '@/components/ui/tinted-host';
import type { DurationPickerProps } from '@/features/schedule/duration-picker.types';

// A custom Delay on Android: Material 3's time input in 24-hour form, read as hours and minutes
// (D-127). The picker holds a time of day, so the amount travels as a time on any one date.
export function DurationPicker({ minutes, onChange }: DurationPickerProps) {
  const start = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toISOString();
  return (
    <TintedHost
      matchContents={{ vertical: true }}
      style={{ width: '100%' }}
      className="text-accent">
      <DateTimePicker
        displayedComponents="hourAndMinute"
        variant="input"
        is24Hour
        initialDate={start}
        onDateSelected={(date) => onChange(date.getHours() * 60 + date.getMinutes())}
      />
    </TintedHost>
  );
}
