import { useState, type Ref } from 'react';
import { Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';

type TextFieldProps = Omit<TextInputProps, 'className' | 'style' | 'placeholder'> & {
  label: string;
  error?: string | null;
  ref?: Ref<TextInput>;
};

// A labelled text input. The label sits above the field and stays there, rather than living in a
// placeholder that disappears once typing starts. That also keeps colors in className, where
// NativeWind v4 maps them; it has no mapping for placeholderTextColor.
//
// A field with secureTextEntry gets a Show button, so a password can be checked before it is sent.
export function TextField({ label, error, ref, secureTextEntry, ...input }: TextFieldProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text className="font-fieldLabel text-fieldLabel text-textSecondary">{label}</Text>
        {secureTextEntry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}
            hitSlop={8}
            onPress={() => setRevealed((value) => !value)}>
            <Text className="font-fieldLabel text-fieldLabel text-accentText">
              {revealed ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        secureTextEntry={secureTextEntry === true && !revealed}
        className={`min-h-12 rounded-xl border bg-surface px-4 py-3 font-body text-body text-textPrimary ${error ? 'border-danger' : 'border-borderStrong'}`}
        {...input}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
