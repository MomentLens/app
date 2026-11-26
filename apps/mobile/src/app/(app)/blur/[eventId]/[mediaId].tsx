import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlurScreen } from '@/features/blur-regions/blur-screen';

export default function BlurRoute() {
  const { eventId, mediaId } = useLocalSearchParams<{ eventId: string; mediaId: string }>();
  return (
    <View className="flex-1">
      <BlurScreen eventId={eventId} mediaId={mediaId} />
      {__DEV__ ? <DevFacesButton eventId={eventId} mediaId={mediaId} /> : null}
    </View>
  );
}

// Development builds only: opens the Recognized Faces strip for this photo (D-176). S-22 deletes
// it with the dev route.
function DevFacesButton({ eventId, mediaId }: { eventId: string; mediaId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        router.push({ pathname: '/dev/faces/[eventId]/[mediaId]', params: { eventId, mediaId } })
      }
      style={{ position: 'absolute', right: 16, bottom: insets.bottom + 96 }}
      className="rounded-full bg-onPhoto/20 px-4 py-2">
      <Text className="font-body text-bodySecondary text-onPhoto">Faces (dev)</Text>
    </Pressable>
  );
}
