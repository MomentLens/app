import { useState, type Ref } from 'react';
import { Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';

type TextFieldProps = Omit<
  TextInputProps,
  'className' | 'style' | 'placeholder' | 'placeholderTextColor' | 'secureTextEntry'
> & {
  label: string;
  icon?: IconName;
  placeholder?: string;
  // A password field: masked, with an eye button that shows what was typed.
  secure?: boolean;
  error?: string | null;
  ref?: Ref<TextInput>;
};

// A labelled text input, laid out as in the Figma frames: an uppercase label above, a leading icon
// inside the field, and for a password an eye button at the end.
//
// The placeholder is a Text drawn behind the input rather than TextInput's own placeholder, whose
// color only takes a value and never a class. NativeWind v4 has no mapping for it, so this keeps the
// color on a token. The label stays visible above the field and is what a screen reader announces.
export function TextField({
  label,
  icon,
  placeholder,
  secure = false,
  error,
  ref,
  value,
  ...input
}: TextFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const showPlaceholder = placeholder !== undefined && (value === undefined || value === '');

  return (
    <View className="gap-2">
      <Text className="font-micro text-micro uppercase tracking-wider text-textSecondary">
        {label}
      </Text>
      <View
        className={`min-h-12 flex-row items-center gap-3 rounded-xl border bg-surface px-4 ${error ? 'border-danger' : 'border-border'}`}>
        {icon ? <Icon name={icon} size={18} className="text-textMuted" /> : null}
        <View className="flex-1 justify-center">
          {showPlaceholder ? (
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="absolute inset-0 justify-center">
              <Text numberOfLines={1} className="font-body text-body text-textMuted">
                {placeholder}
              </Text>
            </View>
          ) : null}
          <TextInput
            ref={ref}
            accessibilityLabel={label}
            value={value}
            secureTextEntry={secure && !revealed}
            className="px-0 py-3 font-body text-body text-textPrimary"
            {...input}
          />
        </View>
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`
            }
            hitSlop={10}
            onPress={() => setRevealed((shown) => !shown)}>
            <Icon name={revealed ? 'eye-off' : 'eye'} size={18} className="text-textMuted" />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
