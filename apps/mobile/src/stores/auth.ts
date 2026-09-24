import { create } from 'zustand';

// Who is signed in, mirrored from Supabase Auth, which owns the tokens (apps/mobile/CLAUDE.md).
// features/auth/session.ts is the only writer apart from the two ends of a session, logout and
// acknowledging Forced Logout. The root layout reads `status` to pick which screens exist.
//
// - signedIn: a session is stored, whether or not its access token is fresh. An offline phone
//   stays here; only Supabase rejecting the refresh token ends a session (D-109).
// - signedOut: nobody, and the user knows it, because they logged out or never logged in.
// - sessionEnded: the session died without the user asking, so Forced Logout explains it instead
//   of a silent bounce to Login (spec §2.5.8).
export type AuthStatus = 'signedIn' | 'signedOut' | 'sessionEnded';

interface AuthState {
  status: AuthStatus;
  userId: string | null;
}

export const useAuthStore = create<AuthState>()(() => ({ status: 'signedOut', userId: null }));

// Forced Logout's one button. Leaving it goes to Login.
export function acknowledgeSessionEnded(): void {
  useAuthStore.setState((state) =>
    state.status === 'sessionEnded' ? { status: 'signedOut', userId: null } : state,
  );
}
