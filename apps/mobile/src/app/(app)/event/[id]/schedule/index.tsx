import { useEventId } from '@/features/event-shell/event-id';
import { ScheduleScreen } from '@/features/schedule/schedule-screen';

// Schedule, for every role. A Photographer reads it and never edits it (spec §4.10).
export default function ScheduleTab() {
  return <ScheduleScreen eventId={useEventId()} />;
}
