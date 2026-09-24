import { Text } from 'react-native';

interface TextLinkProps {
  label: string;
  onPress: () => void;
  // accent for an action the screen invites, muted for a way out, as in the Figma frames.
  tone?: 'accent' | 'muted';
  disabled?: boolean;
}

// An underlined link inside a sentence ("New here? Create account") or on its own line. A Text,
// so it can sit inside another Text and wrap with it.
export function TextLink({ label, onPress, tone = 'accent', disabled = false }: TextLinkProps) {
  return (
    <Text
      accessibilityRole="link"
      accessibilityState={{ disabled }}
      suppressHighlighting
      onPress={disabled ? undefined : onPress}
      className={`font-caption text-caption underline ${tone === 'accent' ? 'text-accentText' : 'text-textSecondary'} ${disabled ? 'opacity-60' : ''}`}>
      {label}
    </Text>
  );
}
