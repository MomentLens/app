import type { MediaImage } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { GLYPH, Glyph } from '@/components/ui/glyph';
import { fitContain, type Size } from '@/features/blur-regions/geometry';
import { presignedSource } from '@/lib/images';

import type { ViewerSlot } from './use-photo-viewer';

export interface PagerValues {
  // The drag offset of the whole pager, in points; 0 at rest.
  pageX: SharedValue<number>;
  // The index of the photo shown, on the UI thread. Each slot sits at (index - current) widths.
  current: SharedValue<number>;
  // The zoom of the photo shown. The neighbours always draw at 1x.
  scale: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
}

interface ZoomablePhotoProps {
  slot: ViewerSlot;
  viewport: Size;
  // The photo's pixel size, from the album row or, failing that, from the loaded image.
  natural: Size | undefined;
  values: PagerValues;
  // The lowest the lock badge may sit, below the top bar, so the bar never hides it.
  badgeTop: number;
  placeholder: MediaImage | undefined;
  onLoadSize: (mediaId: string, size: Size) => void;
  onImageError: (mediaId: string) => void;
  onRetry: (mediaId: string) => void;
}

// One page of the pager: the photo fitted whole on screen, and when it is the photo shown, the
// zoom (D-77). The self-visible marker sits outside the zoom, on the photo's fitted corner, so a
// pinch cannot move it off the photo and it never points at a face (spec §4.11.4.2, D-26). It
// draws from the serving endpoint's own-variant flag alone; the app never learns who the
// subjects are (D-86).
export const ZoomablePhoto = memo(function ZoomablePhoto({
  slot,
  viewport,
  natural,
  values,
  badgeTop,
  placeholder,
  onLoadSize,
  onImageError,
  onRetry,
}: ZoomablePhotoProps) {
  const { pageX, current, scale, tx, ty } = values;
  const { index, image, media } = slot;
  const width = viewport.width;

  const pageStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: (index - current.get()) * width + pageX.get() }] }),
    [index, width],
  );
  const zoomStyle = useAnimatedStyle(() => {
    if (current.get() !== index) return { transform: [{ scale: 1 }] };
    return {
      transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: scale.get() }],
    };
  }, [index]);

  const frame = natural ? fitContain(natural, viewport) : null;

  let body;
  if (image) {
    body = (
      <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]}>
        <Image
          source={presignedSource(image)}
          placeholder={placeholder ? presignedSource(placeholder) : undefined}
          placeholderContentFit="contain"
          contentFit="contain"
          transition={120}
          onLoad={(event) =>
            onLoadSize(media.id, { width: event.source.width, height: event.source.height })
          }
          onError={() => onImageError(media.id)}
          style={StyleSheet.absoluteFill}
          accessibilityRole="image"
          accessibilityLabel="Event photo"
          accessibilityIgnoresInvertColors
        />
      </Animated.View>
    );
  } else if (image === null) {
    // Left out by the serving endpoint, from an answer cached before this screen opened. The album's
    // refetch takes it out of the pager.
    body = (
      <View className="flex-1 items-center justify-center px-8">
        <Text className="text-center font-body text-body text-onPhoto/80">
          This photo is no longer in the album.
        </Text>
      </View>
    );
  } else if (slot.imageError) {
    body = (
      <View className="flex-1 items-center justify-center gap-4 px-8">
        <Text className="text-center font-body text-body text-onPhoto/80">
          Could not load this photo.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => onRetry(media.id)}
          className="min-h-11 items-center justify-center rounded-full bg-onPhoto/15 px-5 active:opacity-70">
          <Text className="font-buttonLabel text-bodySecondary text-onPhoto">Try Again</Text>
        </Pressable>
      </View>
    );
  } else {
    body = (
      <View style={StyleSheet.absoluteFill}>
        {placeholder ? (
          <Image
            source={presignedSource(placeholder)}
            contentFit="contain"
            style={StyleSheet.absoluteFill}
            accessibilityIgnoresInvertColors
          />
        ) : null}
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator className="text-onPhoto" />
        </View>
      </View>
    );
  }

  return (
    <Animated.View style={[StyleSheet.absoluteFill, pageStyle]}>
      {body}
      {/* The placeholder thumbnail is this viewer's own file too, so its flag counts while the
          full image signs. Before the photo's size is known the badge takes the screen's corner. */}
      {(image ?? placeholder)?.isOwnVariant ? (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel="Your face here is visible only to you"
          className="absolute h-8 w-8 items-center justify-center rounded-full bg-scrim/60"
          style={{
            left: (frame?.x ?? 0) + 12,
            top: Math.max((frame?.y ?? 0) + 12, badgeTop),
          }}>
          <Glyph name={GLYPH.ownVariant} size={16} tone="onPhoto" />
        </View>
      ) : null}
    </Animated.View>
  );
});
