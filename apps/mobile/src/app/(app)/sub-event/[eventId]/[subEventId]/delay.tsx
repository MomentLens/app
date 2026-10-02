import { useLocalSearchParams } from 'expo-router';

import { DelaySheet } from '@/features/schedule/delay-sheet';

// The Admin's Delay for one sub-event (spec §2.5.5, D-127), a sheet over the whole Event shell.
export default function DelayScreen() {
  const { eventId, subEventId } = useLocalSearchParams<{ eventId: string; subEventId: string }>();
  return <DelaySheet eventId={eventId} subEventId={subEventId} />;
}
