import { Platform } from 'react-native';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';

interface BackButtonProps {
  onPress: () => void;
  label?: string;
}

// Each platform's own back button, for a screen that draws its own bar (D-125): a round 44pt glass
// button with a chevron and no label on iOS 26, and arrow_back in a 48dp icon button on Android.
export function BackButton({ onPress, label = 'Back' }: BackButtonProps) {
  if (Platform.OS === 'ios') {
    return (
      <GlassButton label={label} onPress={onPress}>
        <Glyph name={GLYPH.back} size={20} tone="textPrimary" />
      </GlassButton>
    );
  }
  return <BarIconButton glyph={GLYPH.back} label={label} onPress={onPress} />;
}
