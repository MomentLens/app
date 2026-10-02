import { useColorScheme } from 'nativewind';
import { ActivityIndicator, Platform, Text, View } from 'react-native';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph, type GlyphName } from '@/components/ui/glyph';
import { useTokenColor } from '@/hooks/use-token-color';

export interface SheetConfirm {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  // done saves the sheet: iOS's prominent checkmark and Android's Save. action is another step,
  // such as Edit: a text button on iOS and, with a glyph, an icon button on Android.
  kind?: 'done' | 'action';
  glyph?: GlyphName;
}

interface SheetToolbarProps {
  title?: string;
  onClose: () => void;
  confirm?: SheetConfirm;
}

// The bar at the top of a sheet (D-125). iOS 26: close on Liquid Glass at the leading end, the
// title in the middle, and a gold checkmark or a text action at the trailing end. Android: Material
// 3's close icon, the title, and Save.
export function SheetToolbar({ title, onClose, confirm }: SheetToolbarProps) {
  const { colorScheme } = useColorScheme();
  const accent = useTokenColor('accent');

  if (Platform.OS === 'ios') {
    const onGold = colorScheme === 'dark' ? 'background' : 'textPrimary';
    return (
      <View className="h-16 flex-row items-center justify-between px-4">
        <GlassButton label="Close" onPress={onClose}>
          <Glyph name={GLYPH.close} size={18} tone="textPrimary" />
        </GlassButton>
        {title ? (
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            className="mx-2 flex-1 text-center font-h2 text-body text-textPrimary">
            {title}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        {confirm ? (
          confirm.kind === 'action' ? (
            <GlassButton
              label={confirm.label}
              onPress={confirm.onPress}
              disabled={confirm.disabled}
              wide>
              <Text className="font-body text-body text-textPrimary">{confirm.label}</Text>
            </GlassButton>
          ) : (
            <GlassButton
              label={confirm.label}
              onPress={confirm.onPress}
              disabled={confirm.disabled || confirm.busy}
              tint={accent}>
              {confirm.busy ? (
                <ActivityIndicator className="text-textPrimary dark:text-background" />
              ) : (
                <Glyph name={GLYPH.check} size={18} tone={onGold} />
              )}
            </GlassButton>
          )
        ) : (
          <View className="w-11" />
        )}
      </View>
    );
  }

  return (
    <View className="h-16 flex-row items-center gap-1 pl-1 pr-4">
      <BarIconButton glyph={GLYPH.close} label="Close" onPress={onClose} />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        className="flex-1 px-1 font-h2 text-h2 text-textPrimary">
        {title ?? ''}
      </Text>
      {confirm ? (
        confirm.kind === 'action' && confirm.glyph ? (
          <BarIconButton
            glyph={confirm.glyph}
            label={confirm.label}
            onPress={confirm.onPress}
            disabled={confirm.disabled}
          />
        ) : (
          <Button
            label={confirm.label}
            size="small"
            variant={confirm.kind === 'action' ? 'quiet' : 'primary'}
            busy={confirm.busy}
            disabled={confirm.disabled}
            onPress={confirm.onPress}
          />
        )
      ) : null}
    </View>
  );
}

// Material 3's 32×4dp drag handle, which a native formSheet does not draw on Android (D-125). iOS
// draws its own grabber, so this draws nothing there.
export function SheetHandle() {
  if (Platform.OS !== 'android') return null;
  return (
    <View className="items-center pb-1 pt-4">
      <View className="h-1 w-8 rounded-full bg-textMuted/40" />
    </View>
  );
}
