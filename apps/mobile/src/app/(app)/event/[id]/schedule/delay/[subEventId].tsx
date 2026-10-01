import { useLocalSearchParams } from 'expo-router';

import { useEventId } from '@/features/event-shell/event-id';
import { DelaySheet } from '@/features/schedule/delay-sheet';

// The Admin's Delay for one sub-event (spec §2.5.5), opened from its row on the Schedule.
export default function DelayScreen() {
  const { subEventId } = useLocalSearchParams<{ subEventId: string }>();
  return <DelaySheet eventId={useEventId()} subEventId={subEventId} />;
}
