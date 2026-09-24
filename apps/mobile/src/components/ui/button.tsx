import { ActivityIndicator, Pressable, Text } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';

type Variant = 'primary' | 'secondary' | 'quiet';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  // Shows a spinner and ignores presses while the action it started is running.
  busy?: boolean;
  disabled?: boolean;
  // What a screen reader adds after the label, e.g. why a button is disabled.
  accessibilityHint?: string;
}

// The gold fill takes dark text in both modes: textPrimary is dark in light mode and background is
// dark in dark mode, where the gold is lighter. The Figma frames use white, which is 2.5:1 on the
// gold and fails WCAG AA (S-01 card, decided at build mobile).
const CONTAINER: Record<Variant, string> = {
  primary: 'rounded-full bg-accent px-6 py-3 active:bg-accentPressed',
  secondary: 'rounded-full border border-borderStrong bg-surface px-6 py-3 active:bg-surfaceMuted',
  quiet: 'px-2 py-2',
};

const LABEL: Record<Variant, string> = {
  primary: 'text-textPrimary dark:text-background',
  secondary: 'text-textPrimary',
  quiet: 'text-accentText',
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  busy = false,
  disabled = false,
  accessibilityHint,
}: ButtonProps) {
  const inactive = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      className={`min-h-12 flex-row items-center justify-center gap-2 ${CONTAINER[variant]} ${inactive ? 'opacity-60' : ''}`}>
      {busy ? (
        <ActivityIndicator className={LABEL[variant]} />
      ) : icon ? (
        <Icon name={icon} size={16} className={LABEL[variant]} />
      ) : null}
      <Text className={`font-buttonLabel text-buttonLabel ${LABEL[variant]}`}>{label}</Text>
    </Pressable>
  );
}
