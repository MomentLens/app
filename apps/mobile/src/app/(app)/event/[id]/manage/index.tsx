import { TabPlaceholder } from '@/features/event-shell/tab-placeholder';

// Manage, the Admin's alone (spec §2.5.1).
export default function ManageTab() {
  return (
    <TabPlaceholder
      icon="pencil"
      title="Event settings"
      body="Invites, members and the event's details are managed here in a later update."
    />
  );
}
