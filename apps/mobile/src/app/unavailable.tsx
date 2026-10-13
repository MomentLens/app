import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { AuthScreen } from '@/features/auth/auth-screen';
import { recheckService } from '@/lib/api';
import { byPlatform } from '@/lib/copy';

// Supabase Unavailable (spec §2.5.8, D-161). The root layout shows it in place of the signed-in app
// once GET /health has answered 503 with `database: error` after an API 500 or a Supabase Auth 5xx.
// Try Again asks GET /health again, and an answer with the database up brings the app back, on the
// Events list. The upload queue keeps its own backoff underneath and loses nothing, which the copy
// says, since a guest's first worry is the photos they just took.
export default function UnavailableScreen() {
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function tryAgain() {
    if (checking) return;
    setChecking(true);
    setProblem(undefined);
    try {
      if ((await recheckService()) === 'down') {
        setProblem('MomentLens still cannot reach its database. Try again in a few minutes.');
      }
    } catch {
      setProblem('MomentLens could not be reached. Check the connection and try again.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <AuthScreen
      variant="status"
      icon="cloud-off"
      title="MomentLens is unavailable"
      subtitle="Its database is not answering, so events and photos cannot load right now. Photos waiting on this phone stay here and upload once it is back."
      footer={
        <>
          {problem ? <FormMessage message={problem} /> : null}
          <Button
            label={checking ? 'Checking' : byPlatform('Try Again', 'Try again')}
            busy={checking}
            onPress={() => void tryAgain()}
          />
        </>
      }
    />
  );
}
