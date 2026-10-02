import { useRouter } from 'expo-router';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { FieldGroup } from '@/components/ui/field-group';
import { TextField } from '@/components/ui/text-field';
import { AuthScreen, Inset } from '@/features/auth/auth-screen';
import { authErrorMessage } from '@/features/auth/messages';
import { byPlatform } from '@/lib/copy';
import { RESET_PASSWORD_URL, supabase } from '@/lib/supabase';

// Asks Supabase to email a recovery link to momentlens://reset-password (D-109), laid out as the
// Figma Forgot Password and Confirmation frames. The link carries a PKCE code that only this phone
// can exchange, because the verifier it needs stays in this phone's storage. Auth answers the same
// whether or not an account uses the address, so the sent state never says one does.
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function sendLink() {
    if (busy) {
      return;
    }
    const address = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(address)) {
      setError('Enter the email address you signed up with.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.resetPasswordForEmail(address, {
        redirectTo: RESET_PASSWORD_URL,
      });
      if (authError) {
        setError(authErrorMessage(authError, 'requestReset'));
      } else {
        setSentTo(address);
      }
    } catch (thrown) {
      setError(authErrorMessage(thrown, 'requestReset'));
    } finally {
      setBusy(false);
    }
  }

  function backToLogin() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/login');
    }
  }

  if (sentTo !== null) {
    return (
      <AuthScreen
        variant="status"
        icon="mail"
        title={byPlatform('Check Your Email', 'Check your email')}
        subtitle={`If an account uses ${sentTo}, a reset link is on its way. Open it on this phone, because it will not work on any other device. Only the newest link works.`}
        onBack={() => setSentTo(null)}
        footer={
          <Button
            label={byPlatform('Back to Log In', 'Back to log in')}
            variant="secondary"
            onPress={backToLogin}
          />
        }
      />
    );
  }

  return (
    <AuthScreen
      title={byPlatform('Reset Password', 'Reset your password')}
      subtitle="We email you a link. Open it on this phone."
      onBack={backToLogin}
      footer={
        <Button
          label={byPlatform('Send Reset Link', 'Send reset link')}
          busy={busy}
          onPress={() => void sendLink()}
        />
      }>
      <FieldGroup>
        <TextField
          label="Email"
          placeholder="name@email.com"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          keyboardType="email-address"
          returnKeyType="send"
          onSubmitEditing={() => void sendLink()}
          editable={!busy}
        />
      </FieldGroup>

      {error ? (
        <Inset>
          <FormMessage message={error} />
        </Inset>
      ) : null}
    </AuthScreen>
  );
}
