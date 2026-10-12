import { useLocalSearchParams } from 'expo-router';
import { ScanResultScreen } from '@/features/verification/scan-result-screen';
export default function ScanResultRoute() {
  const { eventId, subEventId = '' } = useLocalSearchParams<{
    eventId: string;
    subEventId?: string;
  }>();
  return <ScanResultScreen key={eventId} eventId={eventId} subEventId={subEventId} />;
}
