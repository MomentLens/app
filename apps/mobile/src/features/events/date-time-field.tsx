import WheelPicker, { withVirtualized, type PickerItem } from '@quidone/react-native-wheel-picker';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { formatDateTime } from '@/features/events/format';
import {
  DAYS_AHEAD,
  DAYS_BACK,
  dayKey,
  dayKeys,
  fromWheelParts,
  MINUTE_STEP,
  toWheelParts,
  type Meridiem,
  type WheelParts,
} from '@/features/events/time';
import { FieldError, FieldLabel } from '@/features/events/wizard-frame';

// The day wheel holds two years of days, so only the rows near the visible ones are rendered.
const DayWheel = withVirtualized(WheelPicker);

const ITEM_HEIGHT = 36;
const VISIBLE_ITEMS = 5;

const HOURS: PickerItem<number>[] = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: String(i + 1),
}));
const MINUTES: PickerItem<number>[] = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => ({
  value: i * MINUTE_STEP,
  label: String(i * MINUTE_STEP).padStart(2, '0'),
}));
const MERIDIEMS: PickerItem<Meridiem>[] = [
  { value: 'AM', label: 'AM' },
  { value: 'PM', label: 'PM' },
];

function dayLabel(key: string, today: string, thisYear: number): string {
  if (key === today) return 'Today';
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(year === thisYear ? {} : { year: 'numeric' }),
  });
}

function renderItem({ item }: { item: PickerItem<string | number> }) {
  return (
    <Text numberOfLines={1} className="w-full text-center font-body text-body text-textPrimary">
      {item.label}
    </Text>
  );
}

// Each wheel draws no band of its own (the library's is black at 5%, lost in dark mode, and four
// of them read as four boxes). One band on a token runs behind all four instead.
const renderOverlay = null;

interface DateTimeFieldProps {
  label: string;
  value: Date;
  onChange: (value: Date) => void;
  // Only one field's wheels are open at a time; the sheet decides which.
  open: boolean;
  onToggle: () => void;
  error?: string;
}

// A sub-event's start or end: a field showing the time, which opens day, hour, minute and AM/PM
// wheels under it (D-110). Times are the phone's own zone, and a start in the past is allowed.
export function DateTimeField({
  label,
  value,
  onChange,
  open,
  onToggle,
  error,
}: DateTimeFieldProps) {
  const parts = toWheelParts(value);
  const days = useMemo(() => {
    const now = new Date();
    const today = dayKey(now);
    return dayKeys(now, DAYS_BACK, DAYS_AHEAD, value).map((key) => ({
      value: key,
      label: dayLabel(key, today, now.getFullYear()),
    }));
    // The rows depend on the day the value falls on, not its time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts.day]);

  function change(next: Partial<WheelParts>) {
    onChange(fromWheelParts({ ...parts, ...next }));
  }

  return (
    <View className="gap-2">
      <FieldLabel>{label}</FieldLabel>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${formatDateTime(value)}`}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        className={`min-h-12 flex-row items-center justify-between rounded-xl border bg-surface px-4 ${error ? 'border-danger' : open ? 'border-accent' : 'border-border'}`}>
        <Text className="font-body text-body text-textPrimary">{formatDateTime(value)}</Text>
        <Icon name="calendar" size={18} className="text-textMuted" />
      </Pressable>
      {open ? (
        <View className="flex-row items-center rounded-xl border border-border bg-surface px-2">
          <View
            pointerEvents="none"
            style={{ top: ((VISIBLE_ITEMS - 1) / 2) * ITEM_HEIGHT, height: ITEM_HEIGHT }}
            className="absolute inset-x-2 rounded-lg bg-textPrimary/5"
          />
          <View className="flex-[2.4]">
            <DayWheel
              data={days}
              value={parts.day}
              onValueChanged={({ item }) => change({ day: item.value })}
              itemHeight={ITEM_HEIGHT}
              visibleItemCount={VISIBLE_ITEMS}
              renderItem={renderItem}
              renderOverlay={renderOverlay}
              enableScrollByTapOnItem
            />
          </View>
          <View className="flex-1">
            <WheelPicker
              data={HOURS}
              value={parts.hour}
              onValueChanged={({ item }) => change({ hour: item.value })}
              itemHeight={ITEM_HEIGHT}
              visibleItemCount={VISIBLE_ITEMS}
              renderItem={renderItem}
              renderOverlay={renderOverlay}
              enableScrollByTapOnItem
            />
          </View>
          <View className="flex-1">
            <WheelPicker
              data={MINUTES}
              value={parts.minute}
              onValueChanged={({ item }) => change({ minute: item.value })}
              itemHeight={ITEM_HEIGHT}
              visibleItemCount={VISIBLE_ITEMS}
              renderItem={renderItem}
              renderOverlay={renderOverlay}
              enableScrollByTapOnItem
            />
          </View>
          <View className="flex-1">
            <WheelPicker
              data={MERIDIEMS}
              value={parts.meridiem}
              onValueChanged={({ item }) => change({ meridiem: item.value })}
              itemHeight={ITEM_HEIGHT}
              visibleItemCount={VISIBLE_ITEMS}
              renderItem={renderItem}
              renderOverlay={renderOverlay}
              enableScrollByTapOnItem
            />
          </View>
        </View>
      ) : null}
      <FieldError message={error} />
    </View>
  );
}
