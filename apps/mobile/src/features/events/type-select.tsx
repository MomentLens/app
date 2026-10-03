import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AnchoredMenu, type MenuAnchor } from '@/components/ui/anchored-menu';
import { GLYPH } from '@/components/ui/glyph';
import { Icon } from '@/components/ui/icon';
import { EVENT_TYPE_LABEL, EVENT_TYPES, type TypeSelectProps } from '@/features/events/event-type';
import { useTokenColor } from '@/hooks/use-token-color';

// Step 1's Event Type on Android (D-110): Material 3's exposed dropdown, an outlined field that
// opens a menu of the three types under it (D-124).
export function TypeSelect({ value, onChange, error }: TypeSelectProps) {
  const box = useRef<View>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const ripple = useTokenColor('textPrimary', 0.12);
  const open = anchor !== null;

  return (
    <View className="gap-1">
      <View ref={box} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Event type, ${value ? EVENT_TYPE_LABEL[value] : 'not chosen'}`}
          accessibilityState={{ expanded: open }}
          android_ripple={{ color: ripple }}
          onPress={() =>
            box.current?.measureInWindow((x, y, width, height) =>
              setAnchor({ x, y, width, height }),
            )
          }
          className={`h-14 flex-row items-center justify-between rounded-[4px] px-4 ${error ? 'border-2 border-danger' : open ? 'border-2 border-accentText' : 'border border-textMuted'}`}>
          <View className="absolute -top-2.5 left-3 bg-background px-1">
            <Text
              className={`font-caption text-caption ${error ? 'text-danger' : open ? 'text-accentText' : 'text-textSecondary'}`}>
              Event type
            </Text>
          </View>
          <Text className={`font-body text-body ${value ? 'text-textPrimary' : 'text-textMuted'}`}>
            {value ? EVENT_TYPE_LABEL[value] : 'Choose a type'}
          </Text>
          <Icon name="chevron-down" size={20} className="text-textSecondary" />
        </Pressable>
      </View>
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="px-4 font-caption text-caption text-danger">
          {error}
        </Text>
      ) : null}
      <AnchoredMenu
        anchor={anchor}
        items={EVENT_TYPES.map((type) => ({
          key: type,
          label: EVENT_TYPE_LABEL[type],
          glyph: type === value ? GLYPH.check : undefined,
          onPress: () => onChange(type),
        }))}
        onClose={() => setAnchor(null)}
        matchAnchorWidth
      />
    </View>
  );
}
