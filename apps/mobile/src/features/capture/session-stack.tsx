import { Image } from 'expo-image';
import { Pressable, Text, View } from 'react-native';

export interface SessionPhoto {
  id: string;
  uri: string;
}
export function SessionStack({
  photos,
  onPress,
  round,
}: {
  photos: SessionPhoto[];
  onPress: () => void;
  round: boolean;
}) {
  if (!photos.length) return <View style={{ width: 56, height: 56 }} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${photos.length} captures. Review in My Media.`}
      onPress={onPress}
      style={{ width: 56, height: 56 }}>
      {photos.slice(-3).map((photo, index, last) => (
        <View
          key={photo.id}
          className={`absolute overflow-hidden border border-onPhoto/70 bg-scrim ${round ? 'rounded-full' : 'rounded-2xl'}`}
          style={{
            width: 48,
            height: 48,
            left: (last.length - 1 - index) * 3,
            top: (last.length - 1 - index) * 3,
          }}>
          <Image
            source={{ uri: photo.uri }}
            cachePolicy="none"
            contentFit="cover"
            style={{ width: '100%', height: '100%' }}
          />
        </View>
      ))}
      <View className="absolute -bottom-1 -right-1 min-w-6 items-center rounded-full bg-onPhoto px-1.5 py-0.5">
        <Text className="font-micro text-micro text-scrim">{photos.length}</Text>
      </View>
    </Pressable>
  );
}
