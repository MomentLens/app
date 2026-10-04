import { useEventId } from '@/features/event-shell/event-id';
import { ApprovalsScreen } from '@/features/manage/approvals-screen';

export default function ApprovalsRoute() {
  return <ApprovalsScreen eventId={useEventId()} />;
}
