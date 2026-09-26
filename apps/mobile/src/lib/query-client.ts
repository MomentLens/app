import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';

// The app's one TanStack Query client. It lives in a module rather than in the root layout's state
// so that ending a session can clear it from outside React (features/auth/logout.ts). Editing
// another file keeps the cache across Fast Refresh, because only the edited module re-runs.
export const queryClient = new QueryClient();

// React Native has no window focus, so TanStack Query never refetches on return to the app by
// itself. Telling it the app is focused while it is active refetches stale queries whenever the
// app comes back to the foreground, which is when a presigned URL may have expired (arch §3).
focusManager.setEventListener((setFocused) => {
  if (Platform.OS === 'web') {
    return undefined;
  }
  const subscription = AppState.addEventListener('change', (state) => {
    setFocused(state === 'active');
  });
  return () => subscription.remove();
});
