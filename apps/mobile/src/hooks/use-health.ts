import { useQuery } from '@tanstack/react-query';

import { getHealth } from '@/lib/api';

// GET /health as server state, which lives in TanStack Query (apps/mobile/CLAUDE.md).
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => getHealth(signal),
    // One retry instead of the default three, so a real outage reaches the screen in seconds.
    retry: 1,
  });
}
