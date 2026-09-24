import { FullName } from '@momentlens/shared-types';

// The form checks the auth screens run before they call Supabase Auth. Each one is the server's
// own rule, so a form that passes here is one the server accepts.

// Both Supabase projects require this many characters (arch §7).
export const PASSWORD_MIN = 8;

export function passwordError(password: string): string | null {
  return password.length >= PASSWORD_MIN ? null : `Use at least ${PASSWORD_MIN} characters.`;
}

export interface SignupFieldErrors {
  name: string | null;
  email: string | null;
  password: string | null;
}

// FullName is the trigger's own rule (D-109), so a name that passes here is one the database
// accepts. A name the trigger refused would come back as a 500 that looks like a lost connection.
export function signupFieldErrors(
  name: string,
  email: string,
  password: string,
): SignupFieldErrors {
  return {
    name: FullName.safeParse(name).success
      ? null
      : name.trim() === ''
        ? 'Enter your name.'
        : 'Use 80 characters or fewer.',
    // Auth checks the address properly. This only catches a field left empty or half typed.
    email: /^\S+@\S+\.\S+$/.test(email.trim()) ? null : 'Enter your email address.',
    password: passwordError(password),
  };
}
