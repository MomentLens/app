import { useLocalSearchParams } from 'expo-router';

import { useEventId } from '@/features/event-shell/event-id';
import { SubEventDetail } from '@/features/schedule/sub-event-detail';

// Sub-event Detail (spec §2.5.5), opened from a Schedule row or the live card.
export default function SubEventDetailScreen() {
  const { subEventId } = useLocalSearchParams<{ subEventId: string }>();
  return <SubEventDetail eventId={useEventId()} subEventId={subEventId} />;
}
