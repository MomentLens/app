import { useLocalSearchParams } from 'expo-router';
import { ViewfinderScreen } from '@/features/capture/viewfinder-screen';

export default function CaptureRoute() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return <ViewfinderScreen eventId={eventId} />;
}
