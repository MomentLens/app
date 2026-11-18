import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTokenColor } from '@/hooks/use-token-color';

import {
  aperture,
  BAR,
  barsVisible,
  CLICK_END,
  clickOpacity,
  clickScale,
  END,
  endScaleFor,
  interiorOpacity,
  lensRotation,
  lensScale,
  MARK_DIAMETER,
  OPEN,
  R_IN,
  R_OUT,
  SHUT,
  SQRT3,
  UNIT,
} from './iris-timeline';

// Android fades its splash out over 400 ms by default. The overlay's first frame is the same
// picture, so the splash can go at once, and a fade would only blend the still mark with the moving
// one.
SplashScreen.setOptions({ duration: 0, fade: false });

const D = MARK_DIAMETER;
const RING = (R_OUT - R_IN) * UNIT;
// Long enough to reach past the ring at every opening. The part past the ring is under the cream.
const BAR_LENGTH = 480 * UNIT;
// The cream's hole is a fifth of a point inside the ring, so its edge, not the ring's, is the one
// drawn against the cream, and no sliver of the app shows between them.
const HOLE = D / 2 - 0.2;
// The cream inside the lens reaches the middle of the ring, so the ring hides its edge.
const INTERIOR = ((R_IN + R_OUT) / 2) * UNIT;

interface LaunchIrisProps {
  // The app has rendered under the overlay. Until then the shutter stays shut.
  ready: boolean;
  onDone: () => void;
}

// The launch animation, the Iris (designs/splash, direction 21). It starts as the native splash's
// exact picture, the shutter closes and opens, and the lens zooms until its opening clears the
// screen, showing the app underneath. The app loads while it plays: fonts, the restored queries and
// the first screen all render behind it, and the shutter waits shut if they are not done by then.
//
// Everything is a plain view moved by transforms on the UI thread, so a busy JavaScript thread
// cannot stall it, and views are redrawn sharp at any scale, unlike an SVG, which Android draws into
// a bitmap. It blocks touches while it plays, so a tap cannot land on a button nobody can see yet.
export function LaunchIris({ ready, onDone }: LaunchIrisProps) {
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const gold = useTokenColor('accent');
  const cream = useTokenColor('background');

  const clock = useSharedValue(0);
  const click = useSharedValue(-1);
  const fade = useSharedValue(1);
  const [atGate, setAtGate] = useState(false);
  const started = useRef(false);

  const halfDiagonal = Math.hypot(width, height) / 2;
  const endScale = endScaleFor(width, height);
  const border = Math.ceil(halfDiagonal + 24);
  const surround = 2 * (HOLE + border);

  // Hide the native splash only once the overlay has been laid out, and a frame later, so the
  // overlay is on screen before the splash leaves.
  function start() {
    if (started.current) return;
    started.current = true;
    requestAnimationFrame(() => {
      SplashScreen.hide();
      if (reduceMotion) {
        setAtGate(true);
        return;
      }
      clock.value = withTiming(OPEN, { duration: OPEN, easing: Easing.linear }, (finished) => {
        if (finished) scheduleOnRN(setAtGate, true);
      });
      click.value = withDelay(
        SHUT,
        withTiming(CLICK_END, { duration: CLICK_END, easing: Easing.linear }),
      );
    });
  }

  // The second half starts once, when both the shutter and the app are ready. A later render of
  // the root layout must not restart it.
  const opened = useRef(false);
  useEffect(() => {
    if (!atGate || !ready || opened.current) return;
    opened.current = true;
    const finish = (finished?: boolean) => {
      'worklet';
      if (finished) scheduleOnRN(onDone);
    };
    if (reduceMotion) {
      fade.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.quad) }, finish);
    } else {
      clock.value = withTiming(END, { duration: END - OPEN, easing: Easing.linear }, finish);
    }
  }, [atGate, ready, reduceMotion, clock, fade, onDone]);

  const rootStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const lensStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${lensRotation(clock.value)}rad` },
      { scale: lensScale(clock.value, endScale) },
    ],
  }));
  const interiorStyle = useAnimatedStyle(() => ({ opacity: interiorOpacity(clock.value) }));
  // Once the ring's outer edge is past the corners of the screen the cream is all off screen, so
  // it stops being drawn rather than being scaled to tens of thousands of points.
  const surroundStyle = useAnimatedStyle(() => ({
    opacity: lensScale(clock.value, endScale) * HOLE > halfDiagonal ? 0 : 1,
  }));
  const clickStyle = useAnimatedStyle(() =>
    click.value < 0
      ? { opacity: 0 }
      : { opacity: clickOpacity(click.value), transform: [{ scale: clickScale(click.value) }] },
  );

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.center, rootStyle]}
      pointerEvents="auto"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={start}>
      <Animated.View style={[styles.lens, lensStyle]}>
        <Animated.View style={[styles.interior, { backgroundColor: cream }, interiorStyle]} />
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <Bar key={k} k={k} clock={clock} color={gold} />
        ))}
        <View style={[styles.ring, { borderColor: gold }]} />
        <Animated.View
          style={[
            {
              position: 'absolute',
              left: D / 2 - surround / 2,
              top: D / 2 - surround / 2,
              width: surround,
              height: surround,
              borderRadius: surround / 2,
              borderWidth: border,
              borderColor: cream,
            },
            surroundStyle,
          ]}
        />
      </Animated.View>
      <Animated.View style={[styles.click, { borderColor: gold }, clickStyle]} />
    </Animated.View>
  );
}

// Bar k, turned k * 60 degrees about the centre. In its own frame it is a band from the inner
// edge, a units above the centre, to a + BAR, starting at the corner of the hexagonal opening.
// The icon cuts that start on a slant, along the previous bar's edge; a square cut adds a corner
// that always lies inside the previous bar, in the same gold, so a plain rectangle draws the same
// mark and the shutter is one translation.
function Bar({ k, clock, color }: { k: number; clock: SharedValue<number>; color?: string }) {
  const style = useAnimatedStyle(() => {
    const a = aperture(clock.value);
    return {
      opacity: barsVisible(clock.value) ? 1 : 0,
      transform: [{ translateX: (-a / SQRT3) * UNIT }, { translateY: -(a + BAR) * UNIT }],
    };
  });
  return (
    <View collapsable={false} style={[styles.pivot, { transform: [{ rotate: `${k * 60}deg` }] }]}>
      <Animated.View style={[styles.bar, { backgroundColor: color }, style]} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  lens: { width: D, height: D },
  interior: {
    position: 'absolute',
    left: D / 2 - INTERIOR,
    top: D / 2 - INTERIOR,
    width: 2 * INTERIOR,
    height: 2 * INTERIOR,
    borderRadius: INTERIOR,
  },
  pivot: { position: 'absolute', left: D / 2, top: D / 2, width: 0, height: 0 },
  bar: { position: 'absolute', left: 0, top: 0, width: BAR_LENGTH, height: BAR * UNIT },
  ring: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: D,
    height: D,
    borderRadius: D / 2,
    borderWidth: RING,
  },
  click: {
    position: 'absolute',
    width: D,
    height: D,
    borderRadius: D / 2,
    borderWidth: 1.5,
  },
});
