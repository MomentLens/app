import { Redirect, Stack } from 'expo-router';

import { useEventDraft } from '@/features/events/draft';
import { useAuthStore } from '@/stores/auth';

// The Create Event wizard's three steps (spec §2.1.2, D-111). The Events tab starts a draft for
// the signed-in account before opening it. Reached any other way, such as a link, or holding a
// draft another account started, it goes back to the Events tab rather than show that draft.
export default function NewEventLayout() {
  const userId = useAuthStore((state) => state.userId);
  const ownerId = useEventDraft((state) => state.ownerId);
  if (userId === null || ownerId !== userId) {
    return <Redirect href="/" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
