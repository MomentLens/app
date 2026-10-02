import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import type { TextFieldProps } from '@/components/ui/text-field.types';
import { useTokenColor } from '@/hooks/use-token-color';

// Material 3's outlined text field on Android (D-124): a 56dp box whose label rests inside it and
// floats onto the outline once the field has focus or a value, a 2dp outline in the tint while
// focused, and helper or error text under it. The outline is textMuted, 5:1 on the page, because a
// field's edge needs 3:1 (WCAG 1.4.11).
export function TextField({
  label,
  placeholder,
  secure = false,
  error,
  helper,
  on = 'background',
  ref,
  value,
  multiline,
  onFocus,
  onBlur,
  ...input
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const caret = useTokenColor('accentText');
  const muted = useTokenColor('textMuted');
  const raised = focused || (value !== undefined && value !== '') || multiline === true;

  const lift = useSharedValue(raised ? 1 : 0);
  useEffect(() => {
    lift.value = withTiming(raised ? 1 : 0, { duration: 150 });
  }, [lift, raised]);
  // The label rests on the input's line, centred in the 56dp box, and rises to centre on the
  // outline at 12sp, three quarters of its size, shrinking from its left edge.
  const labelStyle = useAnimatedStyle(() => ({
    top: interpolate(lift.value, [0, 1], [16, -12]),
    transform: [{ scale: interpolate(lift.value, [0, 1], [1, 0.75]) }],
  }));

  const outline = error
    ? 'border-2 border-danger'
    : focused
      ? 'border-2 border-accentText'
      : 'border border-textMuted';
  const labelTone = error ? 'text-danger' : focused ? 'text-accentText' : 'text-textSecondary';
  const cut = on === 'surface' ? 'bg-surface' : 'bg-background';

  return (
    <View className="gap-1">
      <View
        className={`flex-row rounded-[4px] ${outline} ${multiline ? 'min-h-[104px] items-start pt-4' : 'h-14 items-center'} ${focused || error ? 'px-[15px]' : 'px-4'}`}>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: focused || error ? 11 : 12,
              transformOrigin: 'left center',
            },
            labelStyle,
          ]}>
          <Text className={`px-1 font-body text-[16px] leading-6 ${labelTone} ${cut}`}>
            {label}
          </Text>
        </Animated.View>
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error ?? helper ?? undefined}
          value={value}
          placeholder={focused ? placeholder : undefined}
          placeholderTextColor={muted}
          cursorColor={caret}
          selectionColor={caret}
          secureTextEntry={secure && !revealed}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={{ paddingVertical: 0, paddingHorizontal: 0 }}
          className={`flex-1 font-body text-body text-textPrimary ${multiline ? 'min-h-[72px]' : ''}`}
          {...input}
        />
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`
            }
            hitSlop={12}
            onPress={() => setRevealed((shown) => !shown)}
            className="ml-3">
            <Icon name={revealed ? 'eye-off' : 'eye'} size={22} className="text-textSecondary" />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          className="px-4 font-caption text-caption text-danger">
          {error}
        </Text>
      ) : helper ? (
        <Text className="px-4 font-caption text-caption text-textSecondary">{helper}</Text>
      ) : null}
    </View>
  );
}
