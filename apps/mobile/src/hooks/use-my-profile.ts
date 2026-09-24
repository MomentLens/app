import { useQuery } from '@tanstack/react-query';

import { ApiError, getMyProfile } from '@/lib/api';

// GET /profiles/me as server state (apps/mobile/CLAUDE.md). api.ts has already refreshed and
// retried once by the time a 401 reaches here, so retrying it again would only repeat that.
export function useMyProfile() {
  return useQuery({
    queryKey: ['profiles', 'me'],
    queryFn: ({ signal }) => getMyProfile(signal),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 1,
  });
}
