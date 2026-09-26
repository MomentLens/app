import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, BackHandler, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { Toggle } from '@/components/ui/toggle';
import { CoverField } from '@/features/events/cover-field';
import { draftHasContent, updateBasics, useEventDraft } from '@/features/events/draft';
import { TypeSelect } from '@/features/events/type-select';
import { basicsProblems } from '@/features/events/validation';
import { WizardFrame } from '@/features/events/wizard-frame';

// Step 1, basic info: name, type, cover, description and Approval Mode (spec §2.1.2, D-111).
export default function BasicInfoStep() {
  const router = useRouter();
  const draft = useEventDraft();
  const [showProblems, setShowProblems] = useState(false);
  const problems = showProblems ? basicsProblems(draft) : {};

  // Leaving the wizard throws the draft away, so it asks first once anything has been entered.
  const close = useCallback(() => {
    if (!draftHasContent(useEventDraft.getState())) {
      router.back();
      return;
    }
    Alert.alert('Discard this event?', 'What you have entered so far will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  }, [router]);

  // Android's back button on the first step would close the wizard without asking. iOS has no
  // gesture for it, since the wizard is presented without one (app/(app)/_layout.tsx).
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        close();
        return true;
      });
      return () => subscription.remove();
    }, [close]),
  );

  function next() {
    setShowProblems(true);
    if (Object.keys(basicsProblems(useEventDraft.getState())).length === 0) {
      router.push('/events/new/sub-events');
    }
  }

  return (
    <WizardFrame
      step={1}
      title="Basic Info"
      back={{ icon: 'x', label: 'Close', onPress: close }}
      footer={<Button label="Next" onPress={next} />}>
      <CoverField cover={draft.cover} onChange={(cover) => updateBasics({ cover })} />
      <TextField
        label="Event name"
        placeholder="Event name"
        value={draft.name}
        onChangeText={(name) => updateBasics({ name })}
        autoCapitalize="words"
        returnKeyType="done"
        error={problems.name}
      />
      <TypeSelect
        value={draft.type}
        onChange={(type) => updateBasics({ type })}
        error={problems.type}
      />
      <TextField
        label="Description"
        placeholder="Tell guests what to expect"
        value={draft.description}
        onChangeText={(description) => updateBasics({ description })}
        multiline
        error={problems.description}
      />
      <View className="flex-row items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3">
        <View className="flex-1 gap-0.5">
          <Text className="font-fieldLabel text-fieldLabel text-textPrimary">Approval Mode</Text>
          <Text className="font-caption text-caption text-textSecondary">
            Approve each new member yourself. Off lets anyone with an invite straight in.
          </Text>
        </View>
        <Toggle
          accessibilityLabel="Approval Mode"
          value={draft.approvalRequired}
          onValueChange={(approvalRequired) => updateBasics({ approvalRequired })}
          className="text-accent"
        />
      </View>
    </WizardFrame>
  );
}
