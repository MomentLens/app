import { FullName } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { TextLink } from '@/components/ui/text-link';
import { AuthScreen } from '@/features/auth/auth-screen';
import { authErrorMessage } from '@/features/auth/messages';
import { supabase } from '@/lib/supabase';

// Both Supabase projects require this many characters (arch §7).
const PASSWORD_MIN = 8;

interface FieldErrors {
  name: string | null;
  email: string | null;
  password: string | null;
}

// FullName is the trigger's own rule (D-109), so a name that passes here is one the database
// accepts. A name the trigger refused would come back as a 500 that looks like a lost connection.
function check(name: string, email: string, password: string): FieldErrors {
  return {
    name: FullName.safeParse(name).success
      ? null
      : name.trim() === ''
        ? 'Enter your name.'
        : 'Use 80 characters or fewer.',
    // Auth checks the address properly. This only catches a field left empty or half typed.
    email: /^\S+@\S+\.\S+$/.test(email.trim()) ? null : 'Enter your email address.',
    password: password.length >= PASSWORD_MIN ? null : `Use at least ${PASSWORD_MIN} characters.`,
  };
}

// Create Account (spec §2.1.1): name, email, password, laid out as the Figma CreateAccount frame.
// The frame's optional profile photo is S-20's, and consent is S-31's gate (D-109). Email
// confirmation is off, so signUp returns a session straight away, and SIGNED_IN takes the app to
// Home.
export default function SignupScreen() {
  const router = useRouter();
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Field errors appear after the first attempt and then follow the typing.
  const shown = attempted ? check(name, email, password) : null;

  async function signUp() {
    if (busy) {
      return;
    }
    setAttempted(true);
    const errors = check(name, email, password);
    const fullName = FullName.safeParse(name);
    if (errors.name || errors.email || errors.password || !fullName.success) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: authError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: fullName.data } },
      });
      if (authError) {
        setError(authErrorMessage(authError, 'signup'));
        setBusy(false);
        return;
      }
      if (data.session === null) {
        // Only possible if a project turned email confirmation back on, against arch §7.
        setError(
          'The account was created, but the server wants the email confirmed first, which this app does not support. Tell the team.',
        );
        setBusy(false);
      }
    } catch (thrown) {
      setError(authErrorMessage(thrown, 'signup'));
      setBusy(false);
    }
  }

  function toLogin() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/login');
    }
  }

  return (
    <AuthScreen title="Create your account">
      <View className="gap-4">
        <TextField
          label="Full name"
          icon="user"
          placeholder="Your full name"
          value={name}
          onChangeText={setName}
          error={shown?.name}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => emailRef.current?.focus()}
          editable={!busy}
        />
        <TextField
          ref={emailRef}
          label="Email address"
          icon="mail"
          placeholder="name@email.com"
          value={email}
          onChangeText={setEmail}
          error={shown?.email}
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
          icon="lock"
          placeholder={`At least ${PASSWORD_MIN} characters`}
          secure
          value={password}
          onChangeText={setPassword}
          error={shown?.password}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={() => void signUp()}
          editable={!busy}
        />
      </View>

      {error ? <FormMessage message={error} /> : null}

      <Button label="Create account" busy={busy} onPress={() => void signUp()} />

      <Text className="text-center font-caption text-caption text-textSecondary">
        Already have an account? <TextLink label="Log in" disabled={busy} onPress={toLogin} />
      </Text>
    </AuthScreen>
  );
}
