import { TabPlaceholder } from '@/features/event-shell/tab-placeholder';

// My Media, every role's own uploads and a Photographer's landing tab (spec §2.5). The camera
// button floats over it, clearing the tab bar with BottomTabInset (hb §16.5).
export default function MediaTab() {
  return (
    <TabPlaceholder
      icon="camera"
      title="Your photos and videos"
      body="What you take or add for this event shows here in a later update."
    />
  );
}
