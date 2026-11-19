import type { BlurRegion, MediaImage } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  contains,
  cornerAt,
  cornerPoint,
  fitContain,
  fromFractions,
  isTooSmall,
  moveWithin,
  rectBetween,
  type Corner,
  type PointRect,
  type Size,
} from '@/features/blur-regions/geometry';
import type { PendingRegion } from '@/features/blur-regions/use-blur-regions';
import { presignedSource } from '@/lib/images';

export const NO_DRAFT: PointRect = { x: 0, y: 0, width: 0, height: 0 };

const HANDLE = 16;

const DRAW = 0;
const MOVE = 1;
const RESIZE = 2;

interface BlurEditorProps {
  image: MediaImage;
  // The photo's pixel size, from the album row. Unknown until the image loads otherwise.
  imageSize: Size | undefined;
  saved: readonly BlurRegion[];
  pending: readonly PendingRegion[];
  // The rectangle being drawn, in points on the photo as it sits on screen. Width 0 means none.
  draft: SharedValue<PointRect>;
  // The photo's size on screen, which the parent needs to turn the draft into fractions.
  onFrame: (frame: Size) => void;
  onDraftChange: (hasDraft: boolean) => void;
  onPressSaved: (region: BlurRegion) => void;
  onPressPending: (region: PendingRegion) => void;
}

// The photo fitted whole on screen, the regions already on it drawn solid, and the rectangle
// being drawn as a dashed outline with four corner handles (design 18, Blur an Area). A drag on
// the photo draws a new rectangle, a drag inside it moves it, and a drag from a handle resizes it.
// A tap on a solid region asks whether to remove it.
export function BlurEditor({
  image,
  imageSize,
  saved,
  pending,
  draft,
  onFrame,
  onDraftChange,
  onPressSaved,
  onPressPending,
}: BlurEditorProps) {
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [loadedSize, setLoadedSize] = useState<Size | undefined>(undefined);
  const natural = imageSize ?? loadedSize;
  const frame = natural ? fitContain(natural, box) : null;
  const size: Size = { width: frame?.width ?? 0, height: frame?.height ?? 0 };

  const mode = useSharedValue(DRAW);
  const anchor = useSharedValue({ x: 0, y: 0 });
  const before = useSharedValue<PointRect>(NO_DRAFT);

  function onLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
  }

  // The parent turns the draft into fractions of this size, so it hears of every change.
  useEffect(() => {
    onFrame({ width: size.width, height: size.height });
  }, [onFrame, size.width, size.height]);

  // A tap lands on the topmost region under it: pending ones draw above saved ones.
  function tapAt(x: number, y: number) {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const region = pending[i]!;
      if (contains(fromFractions(region.rect, size), x, y)) return onPressPending(region);
    }
    for (let i = saved.length - 1; i >= 0; i -= 1) {
      const region = saved[i]!;
      if (contains(fromFractions(region, size), x, y)) return onPressSaved(region);
    }
  }

  const pan = Gesture.Pan()
    .minDistance(4)
    .onStart((e) => {
      const startX = e.x - e.translationX;
      const startY = e.y - e.translationY;
      const current = draft.get();
      before.set(current);
      const corner = current.width > 0 ? cornerAt(current, startX, startY) : -1;
      if (corner !== -1) {
        mode.set(RESIZE);
        anchor.set(cornerPoint(current, ((corner + 2) % 4) as Corner));
      } else if (current.width > 0 && contains(current, startX, startY)) {
        mode.set(MOVE);
      } else {
        mode.set(DRAW);
        anchor.set({ x: startX, y: startY });
      }
    })
    .onUpdate((e) => {
      draft.set(
        mode.get() === MOVE
          ? moveWithin(before.get(), e.translationX, e.translationY, size)
          : rectBetween(anchor.get().x, anchor.get().y, e.x, e.y, size),
      );
    })
    .onEnd(() => {
      // D-170: a drag under 24pt saves nothing, so it leaves the rectangle as it was.
      if (mode.get() !== MOVE && isTooSmall(draft.get())) draft.set(before.get());
      scheduleOnRN(onDraftChange, draft.get().width > 0);
    });

  const tap = Gesture.Tap().onEnd((e) => {
    scheduleOnRN(tapAt, e.x, e.y);
  });

  return (
    <View className="flex-1" onLayout={onLayout}>
      {frame === null ? (
        // The pixel size is not known yet: show the photo fitted, and measure it once it loads.
        <Image
          source={presignedSource(image)}
          contentFit="contain"
          style={StyleSheet.absoluteFill}
          accessibilityIgnoresInvertColors
          onLoad={(event) => {
            setLoadedSize({ width: event.source.width, height: event.source.height });
          }}
        />
      ) : (
        <GestureDetector gesture={Gesture.Race(pan, tap)}>
          <View
            style={{
              position: 'absolute',
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
            }}>
            <Image
              source={presignedSource(image)}
              contentFit="fill"
              style={StyleSheet.absoluteFill}
              accessibilityRole="image"
              accessibilityLabel="Photo"
              accessibilityIgnoresInvertColors
            />
            {saved.map((region) => (
              <SolidRegion
                key={region.id}
                rect={fromFractions(region, size)}
                label={`Blurred area drawn by ${region.drawnBy.fullName}`}
                onActivate={() => onPressSaved(region)}
              />
            ))}
            {pending.map((region) => (
              <SolidRegion
                key={region.id}
                rect={fromFractions(region.rect, size)}
                failed={region.failed}
                label={region.failed ? 'Blurred area, not saved' : 'Blurred area, saving'}
                onActivate={() => onPressPending(region)}
              />
            ))}
            <Draft draft={draft} />
          </View>
        </GestureDetector>
      )}
    </View>
  );
}

// A region drawn solid: once saved, or the moment Blur is pressed (D-170). A failed save keeps
// the solid fill with a red outline until it is sent again or discarded.
function SolidRegion({
  rect,
  label,
  failed = false,
  onActivate,
}: {
  rect: PointRect;
  label: string;
  failed?: boolean;
  onActivate: () => void;
}) {
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      onAccessibilityTap={onActivate}
      className={`absolute bg-scrim ${failed ? 'border-2 border-danger' : 'border border-onPhoto/30'}`}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  );
}

function Draft({ draft }: { draft: SharedValue<PointRect> }) {
  const outline = useAnimatedStyle(() => ({
    left: draft.get().x,
    top: draft.get().y,
    width: draft.get().width,
    height: draft.get().height,
    opacity: draft.get().width > 0 ? 1 : 0,
  }));
  return (
    <>
      {/* The dashed outline is its own view with nothing inside it (apps/mobile AGENTS.md). */}
      <Animated.View
        pointerEvents="none"
        className="absolute border-2 border-dashed border-onPhoto bg-scrim/30"
        style={outline}
      />
      {([0, 1, 2, 3] as const).map((corner) => (
        <Handle key={corner} draft={draft} corner={corner} />
      ))}
    </>
  );
}

function Handle({ draft, corner }: { draft: SharedValue<PointRect>; corner: Corner }) {
  const style = useAnimatedStyle(() => {
    const point = cornerPoint(draft.get(), corner);
    return {
      left: point.x - HANDLE / 2,
      top: point.y - HANDLE / 2,
      opacity: draft.get().width > 0 ? 1 : 0,
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      className="absolute rounded-full bg-onPhoto"
      style={[{ width: HANDLE, height: HANDLE }, style]}
    />
  );
}
