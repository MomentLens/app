import { useRouter } from 'expo-router';

import { startDraft } from '@/features/events/draft';
import { useAuthStore } from '@/stores/auth';

// The wizard is a full-screen modal, so once it is up it covers the tab bar's button and the FAB.
// A second press can only land while it slides in, which takes well under this.
const REPEAT_WINDOW_MS = 1000;
let lastOpenedAt = -Infinity;

// Opens the Create Event wizard on a fresh draft for the signed-in account. The tab bar's button,
// the FAB and the empty Events tab all start it here (spec §2.5.1). A double tap opens it once:
// without the window it pushed two wizards, and the second press reset the first one's draft.
export function useCreateEvent(): () => void {
  const router = useRouter();
  const userId = useAuthStore((state) => state.userId);
  return () => {
    if (userId === null) return;
    const now = Date.now();
    if (now - lastOpenedAt < REPEAT_WINDOW_MS) return;
    lastOpenedAt = now;
    startDraft(userId);
    router.push('/events/new');
  };
}
