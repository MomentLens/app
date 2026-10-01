import { TabPlaceholder } from '@/features/event-shell/tab-placeholder';

// Schedule, for every role. A Photographer reads it and never edits it (spec §4.10).
export default function ScheduleTab() {
  return (
    <TabPlaceholder
      icon="calendar"
      title="The schedule"
      body="Each sub-event, its time and its venue show here in a later update."
    />
  );
}
