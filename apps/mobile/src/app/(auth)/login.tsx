import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { AuthScreen } from '@/features/auth/auth-screen';
import { authErrorMessage } from '@/features/auth/messages';
import { supabase } from '@/lib/supabase';

// Email and password (spec §4.1). A successful login sends SIGNED_IN, and the root layout swaps
// this group for the app, so nothing here navigates on success.
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
    <AuthScreen title="Log in" subtitle="Welcome back to MomentLens.">
      <View className="gap-4">
        <TextField
          label="Email"
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
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void logIn()}
          editable={!busy}
        />
      </View>

      {error ? <FormMessage message={error} /> : null}

      <View className="gap-2">
        <Button label="Log in" busy={busy} onPress={() => void logIn()} />
        <Button
          label="Forgot password?"
          variant="quiet"
          disabled={busy}
          onPress={() => router.push('/forgot-password')}
        />
        <Button
          label="Create an account"
          variant="secondary"
          disabled={busy}
          onPress={() => router.push('/signup')}
        />
      </View>
    </AuthScreen>
  );
}
