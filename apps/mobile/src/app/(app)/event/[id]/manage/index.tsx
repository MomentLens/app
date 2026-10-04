import { useEventId } from '@/features/event-shell/event-id';
import { ManageHub } from '@/features/manage/manage-hub';

// Manage, the Admin's alone (spec §2.5.1, §2.5.7).
export default function ManageTab() {
  return <ManageHub eventId={useEventId()} />;
}
