import { useState } from 'react';
import { Pressable, Text, TextInput } from 'react-native';

import { Row } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import type { TextFieldProps } from '@/components/ui/text-field.types';
import { useTokenColor } from '@/hooks/use-token-color';

// A text field on iOS: one row of an inset grouped section, as Settings and Apple's own sign-in
// forms draw one, with the label as the placeholder and the gold caret (D-124). It must sit inside a
// FieldGroup or a Section.
export function TextField({
  label,
  placeholder: _example,
  secure = false,
  error,
  helper,
  on: _on,
  ref,
  value,
  multiline,
  ...input
}: TextFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const muted = useTokenColor('textMuted');
  const caret = useTokenColor('accentText');

  return (
    <Row
      trailing={
        secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`
            }
            hitSlop={10}
            onPress={() => setRevealed((shown) => !shown)}>
            <Icon name={revealed ? 'eye-off' : 'eye'} size={20} className="text-textMuted" />
          </Pressable>
        ) : undefined
      }>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityHint={error ?? helper ?? undefined}
        value={value}
        placeholder={label}
        placeholderTextColor={muted}
        selectionColor={caret}
        secureTextEntry={secure && !revealed}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : undefined}
        className={`py-1 font-body text-body text-textPrimary ${multiline ? 'min-h-20' : ''}`}
        {...input}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
          {error}
        </Text>
      ) : helper ? (
        <Text className="font-caption text-caption text-textSecondary">{helper}</Text>
      ) : null}
    </Row>
  );
}
