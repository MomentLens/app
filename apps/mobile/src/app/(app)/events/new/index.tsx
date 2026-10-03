import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, BackHandler } from 'react-native';

import { FieldGroup } from '@/components/ui/field-group';
import { Row, Section } from '@/components/ui/grouped';
import { TextField } from '@/components/ui/text-field';
import { Toggle } from '@/components/ui/toggle';
import { CoverField } from '@/features/events/cover-field';
import { draftHasContent, updateBasics, useEventDraft } from '@/features/events/draft';
import { TypeSelect } from '@/features/events/type-select';
import { basicsProblems } from '@/features/events/validation';
import { WizardFrame } from '@/features/events/wizard-frame';
import { byPlatform } from '@/lib/copy';

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
    Alert.alert(
      byPlatform('Discard This Event?', 'Discard this event?'),
      'What you have entered so far will be lost.',
      [
        { text: byPlatform('Keep Editing', 'Keep editing'), style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => router.back() },
      ],
    );
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
      leading={{ kind: 'close', label: 'Close', onPress: close }}
      primary={{ label: 'Next', onPress: next }}>
      <CoverField cover={draft.cover} onChange={(cover) => updateBasics({ cover })} />
      <FieldGroup>
        <TextField
          label="Event name"
          placeholder="Ayesha & Bilal"
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
      </FieldGroup>
      <FieldGroup>
        <TextField
          label={byPlatform('Description (Optional)', 'Description (optional)')}
          placeholder="Tell guests what to expect"
          value={draft.description}
          onChangeText={(description) => updateBasics({ description })}
          multiline
          error={problems.description}
        />
      </FieldGroup>
      <Section
        footer={
          draft.approvalRequired
            ? 'You approve each person before they join.'
            : 'Anyone with an invite joins straight away. Turn it on to approve each person first.'
        }>
        <Row
          title={byPlatform('Approval Mode', 'Approval mode')}
          trailing={
            <Toggle
              accessibilityLabel={byPlatform('Approval Mode', 'Approval mode')}
              value={draft.approvalRequired}
              onValueChange={(approvalRequired) => updateBasics({ approvalRequired })}
            />
          }
        />
      </Section>
    </WizardFrame>
  );
}
