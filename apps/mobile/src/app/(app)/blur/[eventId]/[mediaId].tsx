import { useLocalSearchParams } from 'expo-router';

import { BlurScreen } from '@/features/blur-regions/blur-screen';

export default function BlurRoute() {
  const { eventId, mediaId } = useLocalSearchParams<{ eventId: string; mediaId: string }>();
  return <BlurScreen eventId={eventId} mediaId={mediaId} />;
}
