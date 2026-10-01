import { useLocalSearchParams } from 'expo-router';

import { ScheduleScreen } from '@/features/schedule/schedule-screen';

// Schedule, for every role. A Photographer reads it and never edits it (spec §4.10).
export default function ScheduleTab() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ScheduleScreen eventId={id} />;
}
