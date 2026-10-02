import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { FieldGroup } from '@/components/ui/field-group';
import { TextField } from '@/components/ui/text-field';
import { TextLink } from '@/components/ui/text-link';
import { AuthScreen, Inset } from '@/features/auth/auth-screen';
import { authErrorMessage } from '@/features/auth/messages';
import { JoinBanner } from '@/features/join/join-banner';
import { byPlatform } from '@/lib/copy';
import { supabase } from '@/lib/supabase';

// Email and password (spec §4.1), under the brand lockup with its actions in thumb reach (D-124). A successful login sends
// SIGNED_IN, and the root layout swaps this group for the app, so nothing here navigates on success.
// With an invite waiting, the banner says which event, and the app opens Join Confirmation after
// the login ((app)/_layout.tsx).
export default function LoginScreen() {
  const router = useRouter();
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logIn() {
    if (busy) {
      return;
    }
    const address = email.trim();
    if (address === '' || password === '') {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: address,
        password,
      });
      if (authError) {
        setError(authErrorMessage(authError, 'login'));
        setBusy(false);
      }
    } catch (thrown) {
      setError(authErrorMessage(thrown, 'login'));
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      variant="brand"
      title="Log in to MomentLens"
      subtitle="Every guest's photos from the wedding, in one album."
      footer={
        <>
          <Button label={byPlatform('Log In', 'Log in')} busy={busy} onPress={() => void logIn()} />
          {/* Spec §2.4 step 2: Manual Join Entry, for a code or a pasted link. */}
          <Button
            label={byPlatform('Join with Invite Code', 'Join with invite code')}
            icon="ticket"
            variant="secondary"
            disabled={busy}
            onPress={() => router.push('/join-code')}
          />
          <Text className="pt-1 text-center font-bodySecondary text-bodySecondary text-textSecondary">
            New here?{' '}
            <TextLink
              label={byPlatform('Create Account', 'Create account')}
              disabled={busy}
              onPress={() => router.push('/signup')}
            />
          </Text>
        </>
      }>
      <JoinBanner />
      <View className="gap-2">
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
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
            editable={!busy}
          />
          <TextField
            ref={passwordRef}
            label="Password"
            secure
            value={password}
            onChangeText={setPassword}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => void logIn()}
            editable={!busy}
          />
        </FieldGroup>
        <View className="items-end ios:px-9 android:px-6">
          <TextLink
            label="Forgot password?"
            disabled={busy}
            onPress={() => router.push('/forgot-password')}
          />
        </View>
      </View>

      {error ? (
        <Inset>
          <FormMessage message={error} />
        </Inset>
      ) : null}
    </AuthScreen>
  );
}
