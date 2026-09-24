import { describe, expect, it } from '@jest/globals';
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthWeakPasswordError,
} from '@supabase/supabase-js';

import { authErrorMessage } from '@/features/auth/messages';

const offline = new AuthRetryableFetchError('Network request failed', 0);

describe('authErrorMessage', () => {
  it('says the email or password is wrong for invalid_credentials, and never which one', () => {
    const error = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials');
    expect(authErrorMessage(error, 'login')).toBe('The email or password is wrong.');
  });

  it('sends an existing email to Login instead of signup', () => {
    for (const code of ['user_already_exists', 'email_exists']) {
      const error = new AuthApiError('User already registered', 422, code);
      expect(authErrorMessage(error, 'signup')).toBe(
        'An account already uses this email. Log in instead.',
      );
    }
  });

  it('blames the connection for a network failure', () => {
    expect(authErrorMessage(offline, 'login')).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('does not blame only the connection when signup fails that way', () => {
    // Auth answers a trigger failure with a 500, which auth-js reports exactly like a dropped
    // connection, so the message has to cover both.
    expect(authErrorMessage(offline, 'signup')).toBe(
      'Could not create the account. Check your connection and try again.',
    );
  });

  it('tells a rate-limited reset request to wait', () => {
    const error = new AuthApiError('Email rate limit exceeded', 429, 'over_email_send_rate_limit');
    expect(authErrorMessage(error, 'requestReset')).toBe(
      'Too many reset emails have gone out. Try again in an hour.',
    );
  });

  it('tells any other rate limit to wait a minute', () => {
    const error = new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit');
    expect(authErrorMessage(error, 'login')).toBe(
      'Too many attempts. Wait a minute and try again.',
    );
  });

  it('asks for a stronger password on weak_password', () => {
    const error = new AuthWeakPasswordError('Password is too weak', 422, ['length']);
    expect(authErrorMessage(error, 'setPassword')).toBe('Choose a longer or less common password.');
  });

  it('asks for a different password when the new one is the current one', () => {
    const error = new AuthApiError('New password should be different', 422, 'same_password');
    expect(authErrorMessage(error, 'setPassword')).toBe(
      'That is your current password. Choose a new one.',
    );
  });

  it('sends a reset whose session has gone back to request a new link', () => {
    expect(authErrorMessage(new AuthSessionMissingError(), 'setPassword')).toBe(
      'This reset has expired. Request a new link.',
    );
  });

  it('falls back to a message for the action when the error is unknown', () => {
    expect(authErrorMessage(new Error('something else'), 'requestReset')).toBe(
      'Could not send the reset email. Try again.',
    );
    expect(authErrorMessage(undefined, 'setPassword')).toBe(
      'Could not save the new password. Try again.',
    );
  });
});
