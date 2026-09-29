import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { TextLink } from '@/components/ui/text-link';
import { AuthScreen } from '@/features/auth/auth-screen';
import { authErrorMessage } from '@/features/auth/messages';
import { JoinBanner } from '@/features/join/join-banner';
import { supabase } from '@/lib/supabase';

// Email and password (spec §4.1), laid out as the Figma LoginScreen frame. A successful login sends
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
    <AuthScreen title="Log in to MomentLens" tagline="Weddings & celebrations">
      <JoinBanner />
      <View className="gap-4">
        <TextField
          label="Email address"
          icon="mail"
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
        <View className="gap-2">
          <TextField
            ref={passwordRef}
            label="Password"
            icon="lock"
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
          <View className="items-end">
            <TextLink
              label="Forgot password?"
              tone="muted"
              disabled={busy}
              onPress={() => router.push('/forgot-password')}
            />
          </View>
        </View>
      </View>

      {error ? <FormMessage message={error} /> : null}

      <Button label="Log in" busy={busy} onPress={() => void logIn()} />

      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="font-caption text-caption text-textMuted">or</Text>
        <View className="h-px flex-1 bg-border" />
      </View>

      {/* Spec §2.4 step 2: Manual Join Entry, for a code or a pasted link. */}
      <Button
        label="Join with invite code"
        icon="ticket"
        variant="secondary"
        disabled={busy}
        onPress={() => router.push('/join-code')}
      />

      <Text className="text-center font-caption text-caption text-textSecondary">
        New here?{' '}
        <TextLink label="Create account" disabled={busy} onPress={() => router.push('/signup')} />
      </Text>
    </AuthScreen>
  );
}
