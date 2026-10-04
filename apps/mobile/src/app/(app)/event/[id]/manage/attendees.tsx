import { useEventId } from '@/features/event-shell/event-id';
import { AttendeesScreen } from '@/features/manage/attendees-screen';

export default function AttendeesRoute() {
  return <AttendeesScreen eventId={useEventId()} />;
}
