import { SHORTCODE_LENGTH, type InviteLookup } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { AuthScreen } from '@/features/auth/auth-screen';
import { CodeBoxes } from '@/features/join/code-boxes';
import { useFollowInvite } from '@/features/join/follow-invite';
import { codeProblem, readInviteInput } from '@/features/join/input';
import { inviteQuery, isDeadInvite } from '@/features/join/invite-query';
import { PasteButton } from '@/features/join/paste-button';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

// What shows under the boxes. A field notice is about the code and turns the boxes red; any other
// notice is about getting an answer, and Continue tries again.
interface Notice {
  message: string;
  field: boolean;
}

const NO_MATCH: Notice = {
  message:
    'No live invite uses this code. Check it with the organizer, who may have issued a new one.',
  field: true,
};
const UNREACHABLE: Notice = {
  message: 'The code could not be checked. Check your connection and try again.',
  field: false,
};
const EMPTY_CLIPBOARD: Notice = {
  message: 'The clipboard has no text in it. Copy the code or the link first.',
  field: false,
};

function formatNotice(code: string): Notice | null {
  const message = codeProblem(code);
  return message === null ? null : { message, field: true };
}

// Manual Join Entry (spec §2.4): a typed code, or a pasted invite link. It sits outside both
// guarded groups, because Login opens it signed out and the Events tab opens it signed in.
//
// A code looks itself up as soon as its sixth character lands, since a lookup changes nothing.
// A code that matches no live invite, mistyped or revoked, is told so on the field. A pasted link
// that is dead goes to Join Error, as an opened one does (spec §2.5.8). The field stays editable
// while a lookup runs, so the keyboard never drops; what is typed meanwhile is ignored.
export default function JoinCodeScreen() {
  const router = useRouter();
  const userId = useAuthStore((state) => state.userId);
  const follow = useFollowInvite();
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookUp(lookup: InviteLookup) {
    setBusy(true);
    setNotice(null);
    try {
      const answer = await queryClient.fetchQuery(inviteQuery(userId, lookup));
      follow(lookup, answer);
    } catch (error) {
      if (isDeadInvite(error) && 'token' in lookup) {
        router.replace('/join-error');
        return;
      }
      setNotice(isDeadInvite(error) ? NO_MATCH : UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }

  function take(text: string) {
    if (busy) {
      return;
    }
    const input = readInviteInput(text);
    if (input.kind === 'link') {
      setCode('');
      void lookUp({ token: input.token });
      return;
    }
    // A key press that changes nothing, such as a seventh character, leaves what the field says
    // about the code alone.
    if (input.code === code) {
      return;
    }
    setCode(input.code);
    const wrong = formatNotice(input.code);
    setNotice(wrong);
    if (input.code.length === SHORTCODE_LENGTH && wrong === null) {
      void lookUp({ code: input.code });
    }
  }

  function submit() {
    if (busy || code.length < SHORTCODE_LENGTH) {
      return;
    }
    const wrong = formatNotice(code);
    if (wrong !== null) {
      setNotice(wrong);
      return;
    }
    void lookUp({ code });
  }

  function back() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  return (
    <AuthScreen
      title="Join with a code"
      subtitle="Enter the 6-character code from your invite, or paste the invite link."
      onBack={back}
      footer={
        <Button
          label={busy ? 'Checking' : 'Continue'}
          busy={busy}
          disabled={code.length < SHORTCODE_LENGTH || codeProblem(code) !== null}
          onPress={submit}
        />
      }>
      <View className="gap-3 pt-2">
        <CodeBoxes
          code={code}
          onChangeText={take}
          onSubmit={submit}
          invalid={notice?.field === true}
        />
        {notice ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className={`text-center font-caption text-caption ${notice.field ? 'text-danger' : 'text-textSecondary'}`}>
            {notice.message}
          </Text>
        ) : null}
      </View>

      <View className="items-center">
        <PasteButton
          disabled={busy}
          onPaste={(text) => take(text)}
          onEmpty={() => setNotice(EMPTY_CLIPBOARD)}
        />
      </View>
    </AuthScreen>
  );
}
