import { useQuery } from '@tanstack/react-query';

import { ApiError, getMyProfile } from '@/lib/api';

export const PROFILE_QUERY_KEY = ['profiles', 'me'] as const;

interface UseMyProfileOptions {
  // The root layout asks only while someone is signed in, for the consent gate (D-161).
  enabled?: boolean;
}

// GET /profiles/me as server state (apps/mobile/AGENTS.md). api.ts has already refreshed and
// retried once by the time a 401 reaches here, so retrying it again would only repeat that.
export function useMyProfile({ enabled = true }: UseMyProfileOptions = {}) {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: ({ signal }) => getMyProfile(signal),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 1,
    enabled,
  });
}
