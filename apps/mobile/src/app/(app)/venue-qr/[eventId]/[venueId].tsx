import { useLocalSearchParams } from 'expo-router';
import { VenueQrScreen } from '@/features/venue-qr/venue-qr-screen';
export default function VenueQrRoute() {
  const { eventId, venueId } = useLocalSearchParams<{ eventId: string; venueId: string }>();
  return <VenueQrScreen eventId={eventId} venueId={venueId} />;
}
