import { useEventId } from '@/features/event-shell/event-id';
import { InviteScreen } from '@/features/manage/invite-screen';

export default function InviteRoute() {
  return <InviteScreen eventId={useEventId()} />;
}
