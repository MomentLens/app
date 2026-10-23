import type { MediaImage } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { presignedSource } from '@/lib/images';

interface PhotoTileProps {
  mediaId: string;
  image?: MediaImage;
  onError: (mediaId: string) => void;
}

// 300px WebP thumbnail, center-cropped to square on purpose (spec §4.13, D-105).
// Uniform square height allows FlashList v2 to compute content height without measuring (hb §16).
// The app caches under cacheKey ({objectKey}#v{variant_version}), never url (root invariant 2, D-86).
// A tile the serving endpoint left out never reaches here: sections.ts drops it (D-148).
// Tapping opens nothing until S-22 (D-148).
export const PhotoTile = memo(function PhotoTile({ mediaId, image, onError }: PhotoTileProps) {
  if (!image) {
    return <View className="aspect-square w-full bg-surfaceMuted" />;
  }

  return (
    <View className="aspect-square w-full overflow-hidden bg-surfaceMuted">
      <Image
        source={presignedSource(image)}
        onError={() => onError(mediaId)}
        contentFit="cover"
        transition={150}
        accessibilityRole="image"
        accessibilityLabel="Event photo"
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
});
