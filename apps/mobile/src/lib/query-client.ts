import { QueryClient } from '@tanstack/react-query';

// The app's one TanStack Query client. It lives in a module rather than in the root layout's state
// so that ending a session can clear it from outside React (features/auth/logout.ts). Editing
// another file keeps the cache across Fast Refresh, because only the edited module re-runs.
export const queryClient = new QueryClient();
