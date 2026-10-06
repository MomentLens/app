import type { AlbumMediaItem, MediaImage } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { presignedSource } from '@/lib/images';

interface PhotoTileProps {
  media: AlbumMediaItem;
  image?: MediaImage;
  isResolved: boolean;
}

// 300px WebP thumbnail, center-cropped to square on purpose (spec §4.13, D-105).
// Uniform square height allows FlashList v2 to compute content height without measuring (hb §16).
// The app caches under cacheKey ({objectKey}#v{variant_version}), never url (root invariant 2, D-86).
// When the serving endpoint leaves an id out, the app drops the tile (D-148).
// Tapping opens nothing until S-22 (D-148).
export function PhotoTile({ media: _media, image, isResolved }: PhotoTileProps) {
  // If the batch completed and the id was omitted by the server, drop the tile (D-148)
  if (isResolved && !image) {
    return null;
  }

  if (!image) {
    return <View className="aspect-square w-full bg-surfaceMuted" />;
  }

  return (
    <View className="aspect-square w-full overflow-hidden bg-surfaceMuted">
      <Image
        source={presignedSource(image)}
        contentFit="cover"
        transition={150}
        accessibilityRole="image"
        accessibilityLabel="Event photo"
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
