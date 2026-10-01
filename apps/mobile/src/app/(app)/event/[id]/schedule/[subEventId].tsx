import { useLocalSearchParams } from 'expo-router';

import { SubEventDetail } from '@/features/schedule/sub-event-detail';

// Sub-event Detail (spec §2.5.5), opened from a Schedule row or the live card.
export default function SubEventDetailScreen() {
  const { id, subEventId } = useLocalSearchParams<{ id: string; subEventId: string }>();
  return <SubEventDetail eventId={id} subEventId={subEventId} />;
}
