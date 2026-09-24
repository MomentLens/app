import { Button } from '@/components/ui/button';
import { AuthScreen } from '@/features/auth/auth-screen';
import { acknowledgeSessionEnded } from '@/stores/auth';

// Forced Logout (spec §2.5.8). The session ended without the user asking: Supabase rejected the
// refresh token, which happens after a password change on another device or when the account's
// sessions were revoked (arch §7). Saying so keeps the jump to Login from reading as a bug.
// The root layout shows this screen only while the store says sessionEnded, and leaving it goes to
// Login. No Figma frame covers it, so it follows the Confirmation frame.
export default function SessionEndedScreen() {
  return (
    <AuthScreen
      icon="log-out"
      title="You have been logged out"
      subtitle="Your session ended. This happens when the password is changed on another device, or when the account is signed out everywhere. Log in again to carry on."
      footer={<Button label="Log in" onPress={acknowledgeSessionEnded} />}
    />
  );
}
