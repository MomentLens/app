import { useLocalSearchParams } from 'expo-router';
import { ScanVenueScreen } from '@/features/verification/scan-venue-screen';
export default function ScanVenueRoute() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  return <ScanVenueScreen eventId={eventId} />;
}
