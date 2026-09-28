import { useRouter } from 'expo-router';

import { startDraft } from '@/features/events/draft';
import { useAuthStore } from '@/stores/auth';

// Opens the Create Event wizard on a fresh draft for the signed-in account. The tab bar's button,
// the FAB and the empty Events tab all start it here (spec §2.5.1).
export function useCreateEvent(): () => void {
  const router = useRouter();
  const userId = useAuthStore((state) => state.userId);
  return () => {
    if (userId === null) return;
    startDraft(userId);
    router.push('/events/new');
  };
}
