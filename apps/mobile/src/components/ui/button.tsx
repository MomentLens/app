import { ActivityIndicator, Platform, Pressable, Text } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { useTokenColor } from '@/hooks/use-token-color';

// primary is the screen's one main action. secondary is iOS's gray button and Material 3's
// outlined one. tonal is a quieter filled button on the gold tint. quiet is a text button, and
// destructive the same for an action that gives something up.
type Variant = 'primary' | 'secondary' | 'tonal' | 'quiet' | 'destructive';
type Size = 'regular' | 'small';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  // Shows a spinner and ignores presses while the action it started is running.
  busy?: boolean;
  disabled?: boolean;
  // What a screen reader adds after the label, e.g. why a button is disabled.
  accessibilityHint?: string;
}

// The gold fill takes dark text in both modes: textPrimary is dark in light mode and background is
// dark in dark mode, where the gold is lighter. White on the gold is 2.5:1 and fails WCAG AA.
//
// Each platform's own shape (D-124): iOS's 50pt capsule, and Material 3's 56dp large button for a
// screen's main action and 40dp in a row. A disabled button turns grey on both, as each platform
// draws one, rather than fading the gold so it still looks pressable.
const CONTAINER: Record<Variant, string> = {
  primary: 'rounded-full bg-accent ios:active:bg-accentPressed',
  secondary:
    'rounded-full ios:bg-textPrimary/10 ios:active:bg-textPrimary/20 android:border android:border-borderStrong',
  tonal: 'rounded-full bg-accentTint ios:active:opacity-80',
  quiet: 'rounded-full',
  destructive: 'rounded-full',
};

const LABEL: Record<Variant, string> = {
  primary: 'text-textPrimary dark:text-background',
  secondary: 'ios:text-textPrimary android:text-accentText',
  tonal: 'text-accentText',
  quiet: 'text-accentText',
  destructive: 'text-danger',
};

const HEIGHT: Record<Size, string> = {
  regular: 'ios:min-h-[50px] android:min-h-14 px-6',
  small: 'ios:min-h-9 android:min-h-10 px-4',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'regular',
  icon,
  busy = false,
  disabled = false,
  accessibilityHint,
}: ButtonProps) {
  const inactive = busy || disabled;
  const ripple = useTokenColor('textPrimary', 0.12);
  const filled = variant === 'primary' || variant === 'tonal';
  const container = disabled && filled ? 'rounded-full bg-textPrimary/10' : CONTAINER[variant];
  const labelTone = disabled ? 'text-textMuted' : LABEL[variant];
  const text =
    size === 'small' ? 'font-buttonLabel text-bodySecondary' : 'font-buttonLabel text-buttonLabel';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      android_ripple={Platform.OS === 'android' ? { color: ripple, foreground: true } : undefined}
      className={`flex-row items-center justify-center gap-2 overflow-hidden ${HEIGHT[size]} ${container} ${busy ? 'opacity-70' : ''}`}>
      {busy ? (
        <ActivityIndicator className={labelTone} />
      ) : icon ? (
        <Icon name={icon} size={size === 'small' ? 16 : 18} className={labelTone} />
      ) : null}
      <Text className={`${text} ${labelTone}`}>{label}</Text>
    </Pressable>
  );
}
