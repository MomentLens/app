import {
  isAuthPKCECodeVerifierMissingError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { AuthScreen } from '@/features/auth/auth-screen';
import { authErrorMessage } from '@/features/auth/messages';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';

// Where momentlens://reset-password lands (D-109). It sits outside both guarded groups, because
// the link has to open whether or not someone is signed in.
//
// The link carries a PKCE code. Exchanging it needs the verifier resetPasswordForEmail left in
// this phone's storage, so it works only on the phone that asked. Exchanging signs the user in
// with a recovery session, and the form then sets the new password. If the app dies on the form,
// the recovery session stays signed in and the old password still works (D-109).

// Both Supabase projects require this many characters (arch §7).
const PASSWORD_MIN = 8;

type ExchangeResult = 'ok' | 'expired' | 'otherPhone' | 'offline';

// auth-js deletes the verifier after any exchange, failed or not, so a second exchange of the same
// code would find none and wrongly send the user to another phone. Each code is exchanged once per
// launch, and a remount reuses the answer.
const exchanges = new Map<string, Promise<ExchangeResult>>();

function exchangeOnce(code: string): Promise<ExchangeResult> {
  let pending = exchanges.get(code);
  if (pending === undefined) {
    pending = supabase.auth.exchangeCodeForSession(code).then(
      ({ error }): ExchangeResult => {
        if (error === null) {
          return 'ok';
        }
        if (isAuthPKCECodeVerifierMissingError(error)) {
          return 'otherPhone';
        }
        // The verifier is gone now too, so this link is spent even though the request may never
        // have reached Supabase.
        if (isAuthRetryableFetchError(error)) {
          return 'offline';
        }
        // Already used, expired, or older than a link sent after it.
        return 'expired';
      },
      (): ExchangeResult => 'expired',
    );
    exchanges.set(code, pending);
  }
  return pending;
}

const FAILURES: Record<Exclude<ExchangeResult, 'ok'>, { title: string; message: string }> = {
  expired: {
    title: 'This link has expired',
    message:
      'A reset link works once, and only the newest one you asked for works. Request a new link.',
  },
  otherPhone: {
    title: 'Open the link on the phone that asked for it',
    message:
      'A reset link only works on the phone where it was requested. To reset your password on this phone, request a new link here.',
  },
  offline: {
    title: 'The link could not be checked',
    message:
      'The server could not be reached, and the link cannot be tried again. When you are back online, request a new link.',
  },
};

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const code = typeof params.code === 'string' && params.code !== '' ? params.code : null;
  const status = useAuthStore((state) => state.status);

  const [exchange, setExchange] = useState<{ code: string; result: ExchangeResult } | null>(null);
  // A link without a code is one Supabase refused before redirecting, which it says with
  // error_code instead.
  const result: ExchangeResult | null =
    code === null ? 'expired' : exchange?.code === code ? exchange.result : null;

  useEffect(() => {
    if (code === null) {
      return;
    }
    let active = true;
    void exchangeOnce(code).then((answer) => {
      if (active) {
        setExchange({ code, result: answer });
      }
    });
    return () => {
      active = false;
    };
  }, [code]);

  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The guards pick where '/' lands: Home when signed in, Login when signed out, Forced Logout
  // when the session ended.
  function leave() {
    router.replace('/');
  }

  async function save() {
    if (busy) {
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setFieldError(`Use at least ${PASSWORD_MIN} characters.`);
      return;
    }
    setBusy(true);
    setFieldError(null);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.updateUser({ password });
      if (authError) {
        setError(authErrorMessage(authError, 'setPassword'));
        setBusy(false);
        return;
      }
      router.replace('/');
    } catch (thrown) {
      setError(authErrorMessage(thrown, 'setPassword'));
      setBusy(false);
    }
  }

  if (result === null) {
    return (
      <AuthScreen title="Checking your link">
        <ActivityIndicator className="text-accent" />
      </AuthScreen>
    );
  }

  if (result !== 'ok') {
    const failure = FAILURES[result];
    return (
      <AuthScreen title={failure.title}>
        <FormMessage message={failure.message} />
        <View className="gap-2">
          {status === 'signedOut' ? (
            <Button label="Request a new link" onPress={() => router.replace('/forgot-password')} />
          ) : null}
          <Button
            label={status === 'signedIn' ? 'Go to Home' : 'Back to log in'}
            variant={status === 'signedOut' ? 'quiet' : 'primary'}
            onPress={leave}
          />
        </View>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Choose a new password"
      subtitle="Saving it logs your other devices out within the hour.">
      <TextField
        label="New password"
        value={password}
        onChangeText={setPassword}
        error={fieldError}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        editable={!busy}
      />

      {error ? <FormMessage message={error} /> : null}

      <Button label="Save password" busy={busy} onPress={() => void save()} />
    </AuthScreen>
  );
}
