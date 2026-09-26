import type { EventType } from '@momentlens/shared-types';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { FieldError, FieldLabel } from '@/features/events/wizard-frame';

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  wedding: 'Wedding',
  engagement: 'Engagement',
  other: 'Other',
};

const TYPES: EventType[] = ['wedding', 'engagement', 'other'];

interface TypeSelectProps {
  value: EventType | null;
  onChange: (value: EventType) => void;
  error?: string;
}

// Step 1's Event Type dropdown (D-110), opening in place under the field.
export function TypeSelect({ value, onChange, error }: TypeSelectProps) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <FieldLabel>Event type</FieldLabel>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Event type, ${value ? EVENT_TYPE_LABEL[value] : 'not chosen'}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((shown) => !shown)}
        className={`min-h-12 flex-row items-center justify-between rounded-xl border bg-surface px-4 ${error ? 'border-danger' : 'border-border'}`}>
        <Text className={`font-body text-body ${value ? 'text-textPrimary' : 'text-textMuted'}`}>
          {value ? EVENT_TYPE_LABEL[value] : 'Select event type'}
        </Text>
        <Icon name="chevron-down" size={18} className="text-textMuted" />
      </Pressable>
      {open ? (
        <View
          accessibilityRole="radiogroup"
          className="overflow-hidden rounded-xl border border-border bg-surface">
          {TYPES.map((type, i) => {
            const selected = type === value;
            return (
              <Pressable
                key={type}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  onChange(type);
                  setOpen(false);
                }}
                className={`min-h-12 flex-row items-center justify-between px-4 active:bg-surfaceMuted ${i > 0 ? 'border-t border-border' : ''}`}>
                <Text className="font-body text-body text-textPrimary">
                  {EVENT_TYPE_LABEL[type]}
                </Text>
                {selected ? <Icon name="check" size={18} className="text-accent" /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <FieldError message={error} />
    </View>
  );
}
