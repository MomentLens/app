import {
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
} from '@supabase/supabase-js';

// What each auth screen tells the user when Supabase Auth says no. Auth's own messages are for
// logs, the way ErrorResponse's `message` is (Handbook §5.3), so every line a user reads is here.

export type AuthAction = 'login' | 'signup' | 'requestReset' | 'setPassword';

const FALLBACK: Record<AuthAction, string> = {
  login: 'Could not log in. Try again.',
  signup: 'Could not create the account. Try again.',
  requestReset: 'Could not send the reset email. Try again.',
  setPassword: 'Could not save the new password. Try again.',
};

export function authErrorMessage(error: unknown, action: AuthAction): string {
  if (isAuthRetryableFetchError(error)) {
    // auth-js reports a 5xx from Auth the same way as a dropped connection. Signup is where that
    // matters: the profile trigger refusing a name answers 500 (D-109).
    return action === 'signup'
      ? 'Could not create the account. Check your connection and try again.'
      : 'Could not reach the server. Check your connection and try again.';
  }
  if (isAuthWeakPasswordError(error)) {
    return 'Choose a longer or less common password.';
  }
  if (isAuthSessionMissingError(error)) {
    return action === 'setPassword'
      ? 'This reset has expired. Request a new link.'
      : FALLBACK[action];
  }
  if (!isAuthApiError(error)) {
    return FALLBACK[action];
  }
  switch (error.code) {
    case 'invalid_credentials':
      return 'The email or password is wrong.';
    case 'user_already_exists':
    case 'email_exists':
      return 'An account already uses this email. Log in instead.';
    case 'same_password':
      return 'That is your current password. Choose a new one.';
    case 'email_address_invalid':
      return 'That email address does not look right.';
    case 'email_address_not_authorized':
      // Supabase's built-in sender delivers only to the project team's addresses (D-109).
      return 'This address cannot receive reset emails yet.';
    case 'over_email_send_rate_limit':
      return 'Too many reset emails have gone out. Try again in an hour.';
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return error.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : FALLBACK[action];
  }
}
