import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glyph, type GlyphName } from '@/components/ui/glyph';
import { useTokenColor } from '@/hooks/use-token-color';

export interface MenuItem {
  key: string;
  label: string;
  glyph: GlyphName;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

// Where the long-pressed element sits on screen, from measureInWindow.
export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WIDTH = 220;
const ITEM = 48;
const PAD = 8;

interface AnchoredMenuProps {
  anchor: MenuAnchor | null;
  items: readonly MenuItem[];
  onClose: () => void;
}

// Material 3's menu on Android, opened by a long press on a list row and anchored to it: 48dp
// items with a leading icon on the container tone, under the row or above it when the row sits
// low on the screen (D-127). iOS gets UIKit's context menu instead (expo-router's Link.Menu).
export function AnchoredMenu({ anchor, items, onClose }: AnchoredMenuProps) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const ripple = useTokenColor('textPrimary', 0.12);
  if (anchor === null) return null;

  const height = items.length * ITEM + PAD * 2;
  const below = anchor.y + anchor.height - 8;
  const fitsBelow = below + height < window.height - insets.bottom - 96;
  const top = fitsBelow ? below : Math.max(insets.top + 8, anchor.y - height + 8);
  const left = Math.min(anchor.x + anchor.width - WIDTH - 12, window.width - WIDTH - 12);

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close the menu" onPress={onClose} style={{ flex: 1 }}>
        <View
          accessibilityRole="menu"
          style={{ position: 'absolute', top, left, width: WIDTH, elevation: 3 }}
          className="rounded-xl bg-surfaceContainer py-2">
          {items.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="menuitem"
              accessibilityState={{ disabled: item.disabled }}
              disabled={item.disabled}
              android_ripple={{ color: ripple }}
              onPress={() => {
                onClose();
                item.onPress();
              }}
              style={{ height: ITEM }}
              className={`flex-row items-center gap-3 px-3 ${item.disabled ? 'opacity-40' : ''}`}>
              <Glyph
                name={item.glyph}
                size={24}
                tone={item.destructive ? 'danger' : 'textSecondary'}
              />
              <Text
                className={`font-fieldLabel text-fieldLabel ${item.destructive ? 'text-danger' : 'text-textPrimary'}`}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}
