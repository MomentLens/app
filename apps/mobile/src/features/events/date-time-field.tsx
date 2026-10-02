import { DatePickerDialog, TimePickerDialog } from '@expo/ui/jetpack-compose';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { TintedHost } from '@/components/ui/tinted-host';
import type { DateTimeFieldProps } from '@/features/events/date-time-field.types';
import { formatDay, formatTime } from '@/features/events/format';
import { useTokenColor } from '@/hooks/use-token-color';

// One read-only outlined field that opens a picker, its label always raised onto the outline.
function PickerField({
  label,
  value,
  icon,
  error,
  onPress,
}: {
  label: string;
  value: string;
  icon: IconName;
  error: boolean;
  onPress: () => void;
}) {
  const ripple = useTokenColor('textPrimary', 0.12);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      onPress={onPress}
      android_ripple={{ color: ripple }}
      className={`h-14 flex-1 flex-row items-center justify-between rounded-[4px] px-4 ${error ? 'border-2 border-danger' : 'border border-textMuted'}`}>
      <View className="absolute -top-2.5 left-3 bg-background px-1">
        <Text
          className={`font-caption text-caption ${error ? 'text-danger' : 'text-textSecondary'}`}>
          {label}
        </Text>
      </View>
      <Text className="font-body text-body text-textPrimary">{value}</Text>
      <Icon name={icon} size={20} className="text-textSecondary" />
    </Pressable>
  );
}

// A sub-event's start or end on Android: a date field and a time field that open Material 3's date
// and time picker dialogs (D-128). Times are the phone's own zone, and a start in the past is
// allowed (D-110).
export function DateTimeField({
  dateLabel,
  timeLabel,
  value,
  onChange,
  error,
}: DateTimeFieldProps) {
  const [open, setOpen] = useState<'date' | 'time' | null>(null);

  // The date dialog reads and returns a day as midnight UTC, so the local day goes in that way and
  // comes back out of the UTC fields. Handing it the local instant picked the day before east of
  // UTC, as Pakistan is.
  const day = new Date(
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()),
  ).toISOString();

  return (
    <View className="gap-1">
      <View className="flex-row gap-3">
        <PickerField
          label={dateLabel}
          value={formatDay(value)}
          icon="calendar"
          error={error !== undefined}
          onPress={() => setOpen('date')}
        />
        <PickerField
          label={timeLabel}
          value={formatTime(value)}
          icon="clock"
          error={error !== undefined}
          onPress={() => setOpen('time')}
        />
      </View>
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="px-4 font-caption text-caption text-danger">
          {error}
        </Text>
      ) : null}
      {open === 'date' ? (
        <TintedHost className="text-accent">
          <DatePickerDialog
            initialDate={day}
            onDateSelected={(picked) => {
              setOpen(null);
              onChange(
                new Date(
                  picked.getUTCFullYear(),
                  picked.getUTCMonth(),
                  picked.getUTCDate(),
                  value.getHours(),
                  value.getMinutes(),
                ),
              );
            }}
            onDismissRequest={() => setOpen(null)}
          />
        </TintedHost>
      ) : null}
      {open === 'time' ? (
        <TintedHost className="text-accent">
          <TimePickerDialog
            initialDate={value.toISOString()}
            onDateSelected={(picked) => {
              setOpen(null);
              onChange(
                new Date(
                  value.getFullYear(),
                  value.getMonth(),
                  value.getDate(),
                  picked.getHours(),
                  picked.getMinutes(),
                ),
              );
            }}
            onDismissRequest={() => setOpen(null)}
          />
        </TintedHost>
      ) : null}
    </View>
  );
}
