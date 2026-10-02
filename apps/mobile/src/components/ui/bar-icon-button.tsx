import { Pressable } from 'react-native';

import { Glyph, type GlyphName } from '@/components/ui/glyph';
import { useTokenColor } from '@/hooks/use-token-color';

// Material 3's 48dp icon button for a top app bar, with a round ripple (D-125).
export function BarIconButton({
  glyph,
  label,
  onPress,
  disabled = false,
}: {
  glyph: GlyphName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const ripple = useTokenColor('textPrimary', 0.12);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      android_ripple={{ color: ripple, borderless: true, radius: 24 }}
      className={`h-12 w-12 items-center justify-center ${disabled ? 'opacity-40' : ''}`}>
      <Glyph name={glyph} size={24} tone="textPrimary" />
    </Pressable>
  );
}
