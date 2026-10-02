import { Text, View } from 'react-native';
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  Extrapolation,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { GLYPH } from '@/components/ui/glyph';
import type { LargeTitleScreenProps } from '@/components/ui/large-title-screen.types';
import { useTokenColor } from '@/hooks/use-token-color';

// The 88dp Material 3 gives a large top app bar under its 64dp row, where the title starts.
const LARGE_TITLE_AREA = 88;

// A tab's first screen on Android: Material 3's large top app bar. The title starts large under a
// 64dp row and scrolls away under it, and the row then shows it at title size on the container
// tone (D-125). Android's native header has no large title, so the app draws this one.
export function LargeTitleScreen({
  title,
  subtitle,
  back,
  actions = [],
  trailing,
  refreshControl,
  bottomInset = 0,
  overlay,
  contentClassName = '',
  children,
}: LargeTitleScreenProps) {
  const insets = useSafeAreaInsets();
  const background = useTokenColor('background') ?? 'transparent';
  const container = useTokenColor('surfaceContainer') ?? background;
  const scrollY = useSharedValue(0);
  const largeHeight = useSharedValue(LARGE_TITLE_AREA);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const barStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(scrollY.value, [0, 8], [background, container]),
  }));
  // The small title fades in as the large one slides under the row.
  const smallTitleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [largeHeight.value - 32, largeHeight.value - 8],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <View className="flex-1 bg-background">
      <Animated.View style={[{ paddingTop: insets.top, zIndex: 1 }, barStyle]}>
        <View className="h-16 flex-row items-center gap-1 px-1">
          {back ? (
            <BarIconButton glyph={GLYPH.back} label={back.label} onPress={back.onPress} />
          ) : (
            <View className="w-3" />
          )}
          <Animated.View style={[{ flex: 1 }, smallTitleStyle]}>
            <Text numberOfLines={1} className="font-h2 text-h2 text-textPrimary">
              {title}
            </Text>
          </Animated.View>
          {actions.map((action) =>
            action.glyph ? (
              <BarIconButton
                key={action.key}
                glyph={action.glyph}
                label={action.label}
                onPress={action.onPress}
                disabled={action.disabled}
              />
            ) : null,
          )}
          {trailing ? (
            <View className="h-12 w-12 items-center justify-center">{trailing}</View>
          ) : null}
        </View>
      </Animated.View>

      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}>
        <View
          onLayout={(event) => {
            largeHeight.value = event.nativeEvent.layout.height;
          }}
          style={{ minHeight: LARGE_TITLE_AREA }}
          className="justify-end gap-1 px-4 pb-6">
          <Text
            accessibilityRole="header"
            numberOfLines={2}
            className="font-title text-title text-textPrimary">
            {title}
          </Text>
          {subtitle ? (
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View className={contentClassName}>{children}</View>
      </Animated.ScrollView>
      {overlay}
    </View>
  );
}
