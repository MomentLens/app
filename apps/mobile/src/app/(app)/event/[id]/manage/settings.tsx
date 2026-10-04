import { useEventId } from '@/features/event-shell/event-id';
import { SettingsScreen } from '@/features/manage/settings-screen';

// Event Settings, pushed onto the Manage tab's own Stack from the hub (spec §2.5.7, D-142).
export default function EventSettingsRoute() {
  return <SettingsScreen eventId={useEventId()} />;
}
