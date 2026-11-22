import { useLocalSearchParams } from 'expo-router';

import { ReferencePhotosScreen } from '@/features/references/reference-photos-screen';

export default function ReferencePhotosRoute() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return <ReferencePhotosScreen eventId={eventId} />;
}
