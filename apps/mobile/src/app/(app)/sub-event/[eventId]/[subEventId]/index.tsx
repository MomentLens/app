import { useLocalSearchParams } from 'expo-router';

import { SubEventDetail } from '@/features/schedule/sub-event-detail';

// Sub-event Detail (spec §2.5.5), a sheet over the whole Event shell, opened from a Schedule row or
// the Live card. It sits in the (app) Stack so the Android sheet covers the header and the tab bar
// too (D-125).
export default function SubEventDetailScreen() {
  const { eventId, subEventId } = useLocalSearchParams<{ eventId: string; subEventId: string }>();
  return <SubEventDetail eventId={eventId} subEventId={subEventId} />;
}
