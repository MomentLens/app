import { KeyboardAvoidingView, Text, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { GLYPH } from '@/components/ui/glyph';
import type { SettingsFrameProps } from '@/features/manage/settings-frame.types';
import { useTokenColor } from '@/hooks/use-token-color';

// Event Settings' frame on Android: Material 3's small top app bar, with the back arrow, the
// title and Save, which takes the container tone once the form scrolls under it (D-125).
export function SettingsFrame({ title, save, onBack, children }: SettingsFrameProps) {
  const insets = useSafeAreaInsets();
  const background = useTokenColor('background') ?? 'transparent';
  const container = useTokenColor('surfaceContainer') ?? background;
  const scrollY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const barStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(scrollY.value, [0, 8], [background, container]),
  }));

  return (
    <View className="flex-1 bg-background">
      <Animated.View style={[{ paddingTop: insets.top, zIndex: 1 }, barStyle]}>
        <View className="h-16 flex-row items-center gap-1 pl-1 pr-4">
          <BarIconButton glyph={GLYPH.back} label="Back" onPress={onBack} />
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            className="flex-1 px-1 font-h2 text-h2 text-textPrimary">
            {title}
          </Text>
          <Button
            label={save.label}
            size="small"
            busy={save.busy}
            disabled={save.disabled}
            onPress={save.onPress}
          />
        </View>
      </Animated.View>
      {/* The app draws edge to edge, so Android no longer shrinks the window for the keyboard. */}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40, paddingTop: 8 }}>
          <View className="gap-6">{children}</View>
        </Animated.ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
