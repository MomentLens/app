import { ActivityIndicator, Pressable, Text } from 'react-native';

type Variant = 'primary' | 'secondary' | 'quiet';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  // Shows a spinner and ignores presses while the action it started is running.
  busy?: boolean;
  disabled?: boolean;
}

// The gold fill takes dark text in both modes: textPrimary is dark in light mode and background is
// dark in dark mode, where the gold is lighter.
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
  busy = false,
  disabled = false,
}: ButtonProps) {
  const inactive = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      className={`min-h-12 flex-row items-center justify-center gap-2 ${CONTAINER[variant]} ${inactive ? 'opacity-60' : ''}`}>
      {busy ? <ActivityIndicator className={LABEL[variant]} /> : null}
      <Text className={`font-buttonLabel text-buttonLabel ${LABEL[variant]}`}>{label}</Text>
    </Pressable>
  );
}
