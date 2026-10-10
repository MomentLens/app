import {
  AndroidHaptics,
  ImpactFeedbackStyle,
  impactAsync,
  performAndroidHapticsAsync,
} from 'expo-haptics';
import { useEffect, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTokenColor } from '@/hooks/use-token-color';

// Shared by both platforms' Viewfinders. They live apart from viewfinder.tsx because on iOS
// './viewfinder' resolves to viewfinder.ios.tsx.
// The fitted preview sits under the top bar, as both system cameras place a 4:3 frame, and the
// space it leaves falls to the controls. A black blink over it marks each photo taken.
export function PreviewArea({ preview, shots }: { preview: ReactNode; shots: number }) {
  const scrim = useTokenColor('scrim');
  const opacity = useSharedValue(0);
  useEffect(() => {
    if (shots === 0) return;
    opacity.value = withSequence(
      withTiming(0.85, { duration: 40 }),
      withTiming(0, { duration: 200 }),
    );
  }, [shots, opacity]);
  const blink = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View className="flex-1 items-center">
      {preview}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: scrim }, blink]}
      />
    </View>
  );
}
function shutterHaptic() {
  void (
    Platform.OS === 'android'
      ? performAndroidHapticsAsync(AndroidHaptics.Virtual_Key)
      : impactAsync(ImpactFeedbackStyle.Light)
  ).catch(() => undefined);
}
const PRESS = { damping: 18, stiffness: 420 };
// Both system cameras now draw a white disc inside a translucent ring: Pixel Camera 10.1 for
// Material 3 Expressive and the Camera app from iOS 26. It shrinks under the finger and taps once.
export function Shutter({
  busy,
  ready,
  onPress,
}: {
  busy: boolean;
  ready: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const press = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const disabled = !ready || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Take photo"
      disabled={disabled}
      accessibilityState={{ disabled, busy }}
      onPressIn={() => {
        scale.set(withSpring(0.9, PRESS));
      }}
      onPressOut={() => {
        scale.set(withSpring(1, PRESS));
      }}
      onPress={() => {
        shutterHaptic();
        onPress();
      }}>
      <Animated.View style={press}>
        <View
          className={`h-20 w-20 items-center justify-center rounded-full border-[5px] border-onPhoto/30 ${!ready ? 'opacity-40' : ''}`}>
          <View
            className={`h-[66px] w-[66px] rounded-full ${busy ? 'bg-onPhoto/50' : 'bg-onPhoto'}`}
          />
        </View>
      </Animated.View>
    </Pressable>
  );
}
