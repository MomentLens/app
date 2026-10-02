import { TabPlaceholder } from '@/features/event-shell/tab-placeholder';

// Home, a Guest's and the Admin's landing tab: the album and its filters in one screen (spec §2.5,
// hb §16.5). A Photographer never reaches it (spec §4.10).
export default function HomeTab() {
  return (
    <TabPlaceholder
      icon="aperture"
      title="The album opens here"
      body="Every photo from the event, grouped by sub-event, arrives in a later update."
    />
  );
}
