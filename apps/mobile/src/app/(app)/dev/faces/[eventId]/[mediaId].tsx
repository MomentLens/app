import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FacesStrip } from '@/features/faces/faces-strip';
import { usePhotoFaces } from '@/features/faces/use-photo-faces';

// Development builds only (D-176): the Recognized Faces strip on a bare screen, until S-22 mounts
// it on the single photo view and deletes this route. Reached from the blur screen's Faces button.
export default function DevFacesRoute() {
  const { eventId, mediaId } = useLocalSearchParams<{ eventId: string; mediaId: string }>();
  if (!__DEV__) return <Redirect href="/" />;
  return <DevFaces eventId={eventId} mediaId={mediaId} />;
}

function DevFaces({ eventId, mediaId }: { eventId: string; mediaId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Shares the strip's query, so this reads what the strip read.
  const facesQuery = usePhotoFaces(eventId, mediaId);
  const status = facesQuery.isPending
    ? 'Loading faces…'
    : facesQuery.isError
      ? `Couldn't load faces: ${String(facesQuery.error)}`
      : `${facesQuery.data.faces.length} faces to name`;

  return (
    <View className="flex-1 gap-4 bg-scrim" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between px-4">
        <Text className="font-h2 text-h2 text-onPhoto">Faces (dev)</Text>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => router.back()}>
          <Text className="font-body text-body text-onPhoto">Close</Text>
        </Pressable>
      </View>
      <Text className="px-4 font-bodySecondary text-bodySecondary text-onPhoto/70">{status}</Text>
      <FacesStrip eventId={eventId} mediaId={mediaId} />
    </View>
  );
}
