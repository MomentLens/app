import type { MediaImage, ReviewBlurRegion } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { memo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { fullImageQuery } from '@/features/album/full-image';
import { fitContain, fromFractions, type Size } from '@/features/blur-regions/geometry';
import { presignedSource } from '@/lib/images';

import { whenText } from './model';

const IOS = Platform.OS === 'ios';
// A portrait photo stops at 4:5 of the card's width, so one card never fills the screen. The photo
// sits whole inside that box, so the outline always lands on the area it marks (D-181).
const MAX_RATIO = 1.25;
const FALLBACK: Size = { width: 4, height: 3 };

interface BlurRegionCardProps {
  eventId: string;
  item: ReviewBlurRegion;
  image: MediaImage | undefined;
  disabled: boolean;
  onKeep: (item: ReviewBlurRegion) => void;
  onRemove: (item: ReviewBlurRegion) => void;
  onImageError: (mediaId: string) => void;
}

// One open Guest-drawn blur region in the Review Queue (spec §2.5.7, design 25). The photo is the
// 300px thumbnail at its own aspect ratio with the region outlined by S-19's geometry, never the
// album's square crop, which would move the outline off the face (D-181). The thumbnail already
// has the region blurred: the worker applied it within seconds of the drawing (D-170).
export const BlurRegionCard = memo(function BlurRegionCard({
  eventId,
  item,
  image,
  disabled,
  onKeep,
  onRemove,
  onImageError,
}: BlurRegionCardProps) {
  const [width, setWidth] = useState(0);
  const [loaded, setLoaded] = useState<Size | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const { region, media } = item;
  const natural: Size =
    media.width && media.height
      ? { width: media.width, height: media.height }
      : (loaded ?? FALLBACK);
  const height =
    width > 0 ? Math.min((width * natural.height) / natural.width, width * MAX_RATIO) : 0;
  const drawn = `Drawn by ${region.drawnBy.fullName}`;
  const when = whenText(region.createdAt);

  function onLayout(event: LayoutChangeEvent) {
    setWidth(event.nativeEvent.layout.width);
  }

  return (
    <View className="mx-4 overflow-hidden ios:rounded-[26px] android:rounded-[20px] bg-surface">
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Photo with an area ${drawn.toLowerCase()}`}
        accessibilityHint="Opens the photo full size."
        onPress={() => setPreviewing(true)}
        onLayout={onLayout}
        className="w-full bg-surfaceMuted active:opacity-80"
        style={{ height: height || undefined, aspectRatio: height ? undefined : 4 / 3 }}>
        {width > 0 && height > 0 ? (
          <Outlined
            image={image}
            natural={natural}
            box={{ width, height }}
            rect={region}
            onLoadSize={media.width && media.height ? undefined : setLoaded}
            onError={() => onImageError(media.id)}
          />
        ) : null}
      </Pressable>
      <View className="gap-1 px-5 pt-4">
        <Text numberOfLines={2} className="font-buttonLabel text-buttonLabel text-textPrimary">
          {drawn} · {when}
        </Text>
      </View>
      {IOS ? (
        <View className="flex-row gap-3 px-5 pb-5 pt-4">
          <CardButton label="Keep" disabled={disabled} onPress={() => onKeep(item)} />
          <CardButton
            label="Remove Blur"
            danger
            disabled={disabled}
            onPress={() => onRemove(item)}
          />
        </View>
      ) : (
        <View className="flex-row items-center justify-end gap-2 px-4 pb-4 pt-3">
          <Button
            label="Remove blur"
            variant="destructive"
            size="small"
            disabled={disabled}
            onPress={() => onRemove(item)}
          />
          <Button
            label="Keep"
            variant="tonal"
            size="small"
            disabled={disabled}
            onPress={() => onKeep(item)}
          />
        </View>
      )}
      {previewing ? (
        <RegionPreview
          eventId={eventId}
          item={item}
          placeholder={image}
          natural={media.width && media.height ? natural : loaded}
          onClose={() => setPreviewing(false)}
        />
      ) : null}
    </View>
  );
});

// The photo fitted whole inside `box`, centred, with the region's outline on top. The outline is a
// view of its own with nothing inside it (apps/mobile AGENTS.md, border-dashed).
function Outlined({
  image,
  natural,
  box,
  rect,
  onLoadSize,
  onError,
}: {
  image: MediaImage | undefined;
  natural: Size;
  box: Size;
  rect: ReviewBlurRegion['region'];
  onLoadSize?: (size: Size) => void;
  onError: () => void;
}) {
  const frame = fitContain(natural, box);
  const outline = fromFractions(rect, frame);
  if (!image) return null;
  return (
    <>
      <Image
        source={presignedSource(image)}
        contentFit="contain"
        transition={150}
        accessibilityIgnoresInvertColors
        onLoad={(event) => onLoadSize?.({ width: event.source.width, height: event.source.height })}
        onError={onError}
        style={{
          position: 'absolute',
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
        }}
      />
      <View
        pointerEvents="none"
        className="absolute rounded-md border-2 border-dashed border-onPhoto"
        style={{
          left: frame.x + outline.x,
          top: frame.y + outline.y,
          width: outline.width,
          height: outline.height,
        }}
      />
    </>
  );
}

// iOS's gray capsule, as design 25 draws both actions, with Remove in red.
function CardButton({
  label,
  danger = false,
  disabled,
  onPress,
}: {
  label: string;
  danger?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 flex-1 items-center justify-center rounded-full bg-textPrimary/10 px-4 active:opacity-70 ${
        disabled ? 'opacity-50' : ''
      }`}>
      <Text
        className={`font-buttonLabel text-bodySecondary ${danger ? 'text-danger' : 'text-textPrimary'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

// The photo full size, with the region outlined, over everything (D-181). The full image is signed
// under the album's key with `variant_version` in it (root invariant 2), and the card's thumbnail
// shows while it loads.
function RegionPreview({
  eventId,
  item,
  placeholder,
  natural,
  onClose,
}: {
  eventId: string;
  item: ReviewBlurRegion;
  placeholder: MediaImage | undefined;
  natural: Size | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState<Size | null>(null);
  const full = useQuery(fullImageQuery(eventId, item.media.id, item.media.variantVersion));
  const size = natural ?? loaded;
  const image = full.data ?? placeholder;

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View
        className="flex-1 bg-scrim"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <StatusBar style="light" />
        <View className="h-16 flex-row items-center px-4 android:pl-1">
          {IOS ? (
            <GlassButton label="Close" onPress={onClose}>
              <Glyph name={GLYPH.close} size={20} tone="onPhoto" />
            </GlassButton>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              className="h-12 w-12 items-center justify-center rounded-full active:bg-onPhoto/10">
              <Glyph name={GLYPH.close} tone="onPhoto" />
            </Pressable>
          )}
        </View>
        <View
          className="flex-1"
          onLayout={(event) =>
            setBox({
              width: event.nativeEvent.layout.width,
              height: event.nativeEvent.layout.height,
            })
          }>
          {/* A null answer means the photo was deleted or unpublished: nothing of it shows, the
              card's thumbnail included. */}
          {full.data === null ? (
            <Text className="mt-24 px-8 text-center font-body text-body text-onPhoto">
              This photo is no longer in the album.
            </Text>
          ) : box.width > 0 && image ? (
            <Outlined
              image={image}
              natural={size ?? FALLBACK}
              box={box}
              rect={item.region}
              onLoadSize={natural ? undefined : setLoaded}
              onError={() => void full.refetch()}
            />
          ) : (
            <ActivityIndicator className="mt-24 text-onPhoto" />
          )}
        </View>
      </View>
    </Modal>
  );
}
