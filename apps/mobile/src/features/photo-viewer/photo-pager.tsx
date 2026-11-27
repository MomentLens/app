import type { MediaImage } from '@momentlens/shared-types';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue, withDecay, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { fitContain, type Size } from '@/features/blur-regions/geometry';

import {
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  RUBBER_ZOOM,
  clamp,
  maxOffset,
  zoomAbout,
} from './model';
import type { ViewerSlot } from './use-photo-viewer';
import { ZoomablePhoto, type PagerValues } from './zoomable-photo';

// A swipe turns the page past a quarter of the screen, or on a flick faster than this.
const FLICK = 600;
const SETTLE_MS = 220;
const ZOOMED = 1.01;
const SPRING = { damping: 30, stiffness: 300 };

interface PhotoPagerProps {
  slots: readonly ViewerSlot[];
  currentIndex: number;
  count: number;
  badgeTop: number;
  placeholders: Readonly<Record<string, MediaImage | undefined>>;
  // A page turn, by one photo either way, after the pager has already drawn it.
  onTurn: (direction: 1 | -1) => void;
  onTap: () => void;
  onImageError: (mediaId: string) => void;
  onRetry: (mediaId: string) => void;
}

// The full-screen swipeable pager, built from gesture-handler and Reanimated rather than a pager
// library so that panning a zoomed photo and turning the page can be told apart in one place
// (D-77). It mounts three photos (D-179). Every slot sits at (its index - the current index)
// screen widths plus the drag, all on the UI thread: when a turn settles, the current index and
// the drag change in the same frame, so nothing jumps, and React swaps in the new neighbour after.
//
// - Pinch zooms the photo shown from 1x to 4x, rubber-banding below 1x and springing back.
// - Double-tap toggles 1x and 2.5x about the tapped point.
// - One finger on a zoomed photo pans it, and never turns the page; at 1x a sideways swipe turns
//   it (Ukasha, S-22 mobile build).
// - Zoom resets whenever the page settles on another photo (D-179).
export function PhotoPager({
  slots,
  currentIndex,
  count,
  badgeTop,
  placeholders,
  onTurn,
  onTap,
  onImageError,
  onRetry,
}: PhotoPagerProps) {
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState<Readonly<Record<string, Size>>>({});

  const pageX = useSharedValue(0);
  const current = useSharedValue(currentIndex);
  const total = useSharedValue(count);
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const values = useMemo<PagerValues>(
    () => ({ pageX, current, scale, tx, ty }),
    [pageX, current, scale, tx, ty],
  );

  // Where a gesture started, and the size of the photo shown as it sits fitted on screen.
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const focusX = useSharedValue(0);
  const focusY = useSharedValue(0);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const frameW = useSharedValue(0);
  const frameH = useSharedValue(0);
  const zoomPanning = useSharedValue(false);
  const paging = useSharedValue(false);
  const settling = useSharedValue(false);

  const naturalOf = useCallback(
    (slot: ViewerSlot): Size | undefined =>
      slot.media.width && slot.media.height
        ? { width: slot.media.width, height: slot.media.height }
        : loaded[slot.media.id],
    [loaded],
  );

  const shown = slots.find((slot) => slot.index === currentIndex);

  // React moved the pager itself: a turn the UI thread already drew, a photo that left so its
  // neighbour took its place, an accessibility action. Whenever another photo is shown, it starts
  // at 1x (D-179).
  const shownId = useRef(shown?.media.id);
  useLayoutEffect(() => {
    total.set(count);
    const moved = current.get() !== currentIndex;
    if (moved || shownId.current !== shown?.media.id) {
      current.set(currentIndex);
      if (moved) pageX.set(0);
      scale.set(1);
      tx.set(0);
      ty.set(0);
    }
    shownId.current = shown?.media.id;
  }, [currentIndex, count, shown?.media.id, current, total, pageX, scale, tx, ty]);

  const shownNatural = shown ? naturalOf(shown) : undefined;
  useLayoutEffect(() => {
    const frame = shownNatural ? fitContain(shownNatural, viewport) : viewport;
    frameW.set(frame.width);
    frameH.set(frame.height);
  }, [shownNatural, viewport, frameW, frameH]);

  const onLoadSize = useCallback((mediaId: string, size: Size) => {
    setLoaded((before) => (before[mediaId] ? before : { ...before, [mediaId]: size }));
  }, []);

  const vw = viewport.width;
  const vh = viewport.height;

  // Back inside 1x to 4x, with the photo's edges no further in than the screen's.
  function settleZoom() {
    'worklet';
    const target = clamp(scale.get(), MIN_ZOOM, MAX_ZOOM);
    if (target <= ZOOMED) {
      scale.set(withSpring(1, SPRING));
      tx.set(withSpring(0, SPRING));
      ty.set(withSpring(0, SPRING));
      return;
    }
    const mx = maxOffset(frameW.get(), vw, target);
    const my = maxOffset(frameH.get(), vh, target);
    scale.set(withSpring(target, SPRING));
    tx.set(withSpring(clamp(tx.get(), -mx, mx), SPRING));
    ty.set(withSpring(clamp(ty.get(), -my, my), SPRING));
  }

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      if (settling.get()) return;
      if (pageX.get() !== 0) pageX.set(withTiming(0, { duration: SETTLE_MS }));
      startScale.set(scale.get());
      startX.set(tx.get());
      startY.set(ty.get());
      focusX.set(e.focalX - vw / 2);
      focusY.set(e.focalY - vh / 2);
    })
    .onUpdate((e) => {
      if (settling.get()) return;
      const next = clamp(startScale.get() * e.scale, RUBBER_ZOOM, MAX_ZOOM);
      // The point first pinched stays under the fingers, and follows them as they move.
      const fx = e.focalX - vw / 2;
      const fy = e.focalY - vh / 2;
      tx.set(zoomAbout(focusX.get(), startX.get(), startScale.get(), next) + fx - focusX.get());
      ty.set(zoomAbout(focusY.get(), startY.get(), startScale.get(), next) + fy - focusY.get());
      scale.set(next);
    })
    .onEnd(() => {
      if (!settling.get()) settleZoom();
    });

  // One finger on a zoomed photo moves it, and stops at its edges.
  const zoomPan = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      zoomPanning.set(!settling.get() && scale.get() > ZOOMED);
      panX.set(tx.get());
      panY.set(ty.get());
    })
    .onUpdate((e) => {
      if (!zoomPanning.get()) return;
      const mx = maxOffset(frameW.get(), vw, scale.get());
      const my = maxOffset(frameH.get(), vh, scale.get());
      tx.set(clamp(panX.get() + e.translationX, -mx, mx));
      ty.set(clamp(panY.get() + e.translationY, -my, my));
    })
    .onEnd((e) => {
      if (!zoomPanning.get()) return;
      const mx = maxOffset(frameW.get(), vw, scale.get());
      const my = maxOffset(frameH.get(), vh, scale.get());
      tx.set(withDecay({ velocity: e.velocityX, clamp: [-mx, mx] }));
      ty.set(withDecay({ velocity: e.velocityY, clamp: [-my, my] }));
    });

  // A sideways swipe at 1x turns the page. Past either end it drags a third as far and springs
  // back.
  const pagePan = Gesture.Pan()
    .maxPointers(1)
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onStart(() => {
      paging.set(!settling.get() && scale.get() <= ZOOMED);
    })
    .onUpdate((e) => {
      if (!paging.get()) return;
      const index = current.get();
      const pastEnd =
        (e.translationX > 0 && index <= 0) || (e.translationX < 0 && index >= total.get() - 1);
      pageX.set(pastEnd ? e.translationX / 3 : e.translationX);
    })
    .onEnd((e) => {
      if (!paging.get()) return;
      const index = current.get();
      let direction = 0;
      if ((e.translationX < -vw / 4 || e.velocityX < -FLICK) && index < total.get() - 1) {
        direction = 1;
      } else if ((e.translationX > vw / 4 || e.velocityX > FLICK) && index > 0) {
        direction = -1;
      }
      if (direction === 0) {
        pageX.set(withSpring(0, SPRING));
        return;
      }
      settling.set(true);
      pageX.set(
        withTiming(-direction * vw, { duration: SETTLE_MS }, (finished) => {
          if (finished) {
            current.set(index + direction);
            pageX.set(0);
            scale.set(1);
            tx.set(0);
            ty.set(0);
            scheduleOnRN(onTurn, direction as 1 | -1);
          }
          settling.set(false);
        }),
      );
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      if (settling.get()) return;
      if (scale.get() > ZOOMED) {
        scale.set(withSpring(1, SPRING));
        tx.set(withSpring(0, SPRING));
        ty.set(withSpring(0, SPRING));
        return;
      }
      // The tapped point stays where it is as the photo grows about the screen's centre.
      const mx = maxOffset(frameW.get(), vw, DOUBLE_TAP_ZOOM);
      const my = maxOffset(frameH.get(), vh, DOUBLE_TAP_ZOOM);
      scale.set(withSpring(DOUBLE_TAP_ZOOM, SPRING));
      tx.set(withSpring(clamp(zoomAbout(e.x - vw / 2, 0, 1, DOUBLE_TAP_ZOOM), -mx, mx), SPRING));
      ty.set(withSpring(clamp(zoomAbout(e.y - vh / 2, 0, 1, DOUBLE_TAP_ZOOM), -my, my), SPRING));
    });

  const singleTap = Gesture.Tap().onEnd(() => {
    scheduleOnRN(onTap);
  });

  const gesture = Gesture.Race(
    Gesture.Simultaneous(pinch, zoomPan, pagePan),
    Gesture.Exclusive(doubleTap, singleTap),
  );

  function onLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ width, height });
  }

  return (
    <GestureDetector gesture={gesture}>
      <View
        className="flex-1 overflow-hidden"
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Photo ${currentIndex + 1} of ${count}`}
        accessibilityActions={[
          { name: 'increment', label: 'Next photo' },
          { name: 'decrement', label: 'Previous photo' },
          { name: 'activate', label: 'Show or hide photo details' },
        ]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName;
          if (action === 'increment' && currentIndex < count - 1) onTurn(1);
          else if (action === 'decrement' && currentIndex > 0) onTurn(-1);
          else if (action === 'activate') onTap();
        }}>
        {vw > 0
          ? slots.map((slot) => (
              <ZoomablePhoto
                key={slot.media.id}
                slot={slot}
                viewport={viewport}
                natural={naturalOf(slot)}
                values={values}
                badgeTop={badgeTop}
                placeholder={placeholders[slot.media.id]}
                onLoadSize={onLoadSize}
                onImageError={onImageError}
                onRetry={onRetry}
              />
            ))
          : null}
      </View>
    </GestureDetector>
  );
}
