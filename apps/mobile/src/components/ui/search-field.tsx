import { Pressable, TextInput, View, type TextInputProps } from 'react-native';

import { GLYPH, Glyph } from '@/components/ui/glyph';
import { useTokenColor } from '@/hooks/use-token-color';

type SearchFieldProps = Omit<TextInputProps, 'className' | 'style' | 'placeholderTextColor'> & {
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
};

// Each platform's search field (D-124): iOS's capsule with a magnifying glass, and Material 3's
// 56dp search bar on the container tone. A clear button shows once there is text.
export function SearchField({ placeholder, value, onChangeText, ...input }: SearchFieldProps) {
  const muted = useTokenColor('textMuted');
  const caret = useTokenColor('accentText');
  return (
    <View className="flex-row items-center gap-2.5 rounded-full ios:h-11 ios:bg-textPrimary/[0.07] ios:px-3.5 android:h-14 android:bg-surfaceContainer android:px-4">
      <Glyph name={GLYPH.search} size={18} tone="textSecondary" />
      <TextInput
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={muted}
        selectionColor={caret}
        cursorColor={caret}
        value={value}
        onChangeText={onChangeText}
        style={{ paddingVertical: 0 }}
        className="flex-1 font-body text-body text-textPrimary"
        {...input}
      />
      {value !== '' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear"
          hitSlop={10}
          onPress={() => onChangeText('')}>
          <Glyph name={GLYPH.close} size={16} tone="textSecondary" />
        </Pressable>
      ) : null}
    </View>
  );
}
