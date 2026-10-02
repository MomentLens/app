import { Text } from 'react-native';

interface TextLinkProps {
  label: string;
  onPress: () => void;
  // accent for an action the screen invites, muted for a way out, as in the Figma frames.
  tone?: 'accent' | 'muted';
  disabled?: boolean;
}

// A text button inside a sentence ("New here? Create account") or on its own line, in the tint
// with no underline, as both platforms draw one (D-124). A Text, so it can sit inside another Text
// and wrap with it.
export function TextLink({ label, onPress, tone = 'accent', disabled = false }: TextLinkProps) {
  return (
    <Text
      accessibilityRole="link"
      accessibilityState={{ disabled }}
      suppressHighlighting
      onPress={disabled ? undefined : onPress}
      className={`font-fieldLabel text-bodySecondary ${tone === 'accent' ? 'text-accentText' : 'text-textSecondary'} ${disabled ? 'opacity-60' : ''}`}>
      {label}
    </Text>
  );
}
