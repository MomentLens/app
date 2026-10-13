import { create } from 'zustand';

import { useAuthStore } from '@/stores/auth';

// Whether GET /health last said the Supabase project is down, asked after an API 500 or a Supabase
// Auth 5xx (hb §5.3, D-161). lib/api.ts is the only writer. While it is true the root layout shows
// Supabase Unavailable in place of the signed-in app, and only Try Again clears it.
interface ServiceState {
  unavailable: boolean;
}

export const useServiceStore = create<ServiceState>()(() => ({ unavailable: false }));

export function setServiceUnavailable(unavailable: boolean): void {
  useServiceStore.setState({ unavailable });
}

// Another account starts clear. The first 500 it meets asks again.
useAuthStore.subscribe((state, previous) => {
  if (state.userId !== previous.userId) setServiceUnavailable(false);
});
