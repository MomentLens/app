import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { useTokenColor } from '@/hooks/use-token-color';

export type GlyphName = Extract<SymbolViewProps['name'], { ios?: unknown }>;

// The chrome's own glyphs, SF Symbols on iOS and Material Symbols on Android, for bars, sheets and
// menus (D-124). Content icons stay Lucide (icon.tsx), drawn the same on both.
export const GLYPH = {
  back: { ios: 'chevron.backward', android: 'arrow_back' },
  close: { ios: 'xmark', android: 'close' },
  check: { ios: 'checkmark', android: 'check' },
  add: { ios: 'plus', android: 'add' },
  join: { ios: 'ticket', android: 'confirmation_number' },
  edit: { ios: 'pencil', android: 'edit' },
  delay: { ios: 'timer', android: 'more_time' },
  directions: { ios: 'arrow.triangle.turn.up.right.diamond', android: 'directions' },
  photos: { ios: 'photo.on.rectangle', android: 'photo_library' },
  location: { ios: 'location', android: 'my_location' },
  search: { ios: 'magnifyingglass', android: 'search' },
  chevron: { ios: 'chevron.forward', android: 'chevron_right' },
  logout: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout' },
  trash: { ios: 'trash', android: 'delete' },
  qr: { ios: 'qrcode', android: 'qr_code_2' },
  clock: { ios: 'clock', android: 'schedule' },
  venue: { ios: 'mappin.and.ellipse', android: 'add_location_alt' },
  pin: { ios: 'mappin', android: 'location_on' },
} as const satisfies Record<string, GlyphName>;

interface GlyphProps {
  name: GlyphName;
  size?: number;
  // A color token from global.css, read as a native color so dark mode follows.
  tone?: string;
}

export function Glyph({ name, size = 24, tone = 'textPrimary' }: GlyphProps) {
  const tint = useTokenColor(tone);
  return <SymbolView name={name} size={size} tintColor={tint} />;
}
