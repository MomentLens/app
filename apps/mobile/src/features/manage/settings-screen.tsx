import { useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Platform, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field-group';
import { FormMessage } from '@/components/ui/form-message';
import { Row, Section } from '@/components/ui/grouped';
import { TextField } from '@/components/ui/text-field';
import { Toggle } from '@/components/ui/toggle';
import { tabHref } from '@/features/event-shell/tabs';
import { useEvent } from '@/features/event-shell/use-event';
import { CoverField } from '@/features/events/cover-field';
import type { DraftCover } from '@/features/events/draft';
import { formatEventDates } from '@/features/events/format';
import {
  approvalNote,
  settingsPatch,
  settingsProblems,
  shownSettings,
  stillWaitingMessage,
  switchMessage,
  type SettingsEdits,
} from '@/features/manage/settings';
import { SettingsFrame } from '@/features/manage/settings-frame';
import {
  freshSettings,
  saveCover,
  saveDetails,
  useEventSettings,
} from '@/features/manage/use-event-settings';
import { byPlatform } from '@/lib/copy';

const IOS = Platform.OS === 'ios';

// An alert with Cancel and one action, answered as a promise. Dismissing it on Android counts as
// Cancel.
function ask(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

// Event Settings (spec §2.5.7, D-142): the event's name, description, cover and Approval Mode, for
// the Admin. Save stays off until something differs from what is saved, sends only what changed,
// and then uploads a picked cover. A switch to auto with anyone pending asks first, naming each
// Photographer it lets in. The dates follow the sub-events and change only in the Schedule (D-88).
// The Danger Zone arrives at the foot of the form with S-31a.
export function SettingsScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const navigation = useNavigation();
  const event = useEvent(eventId).data?.event;
  const query = useEventSettings(eventId);
  const settings = query.data;
  const [edits, setEdits] = useState<SettingsEdits>({});
  const [cover, setCover] = useState<DraftCover | null>(null);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const shown = settings ? shownSettings(settings, edits) : null;
  const dirty =
    settings !== undefined && (settingsPatch(settings, edits) !== null || cover !== null);
  const problems = shown && showProblems ? settingsProblems(shown) : {};

  // Leaving with changes asks first, and nothing leaves while a save is running, so the save's own
  // way back never pops the hub instead. Once a save has finished the screen closes itself.
  usePreventRemove(!closing && (saving || dirty), ({ data }) => {
    if (saving) return;
    Alert.alert(
      byPlatform('Discard Changes?', 'Discard changes?'),
      'What you changed here has not been saved.',
      [
        { text: byPlatform('Keep Editing', 'Keep editing'), style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
      ],
    );
  });
  useEffect(() => {
    if (closing) router.back();
  }, [closing, router]);

  function edit(change: SettingsEdits) {
    setEdits((current) => ({ ...current, ...change }));
  }

  function stop(message: string) {
    setProblem(message);
    setSaving(false);
  }

  async function save() {
    if (saving || !settings || !shown) return;
    setShowProblems(true);
    if (Object.keys(settingsProblems(shown)).length > 0) return;
    setSaving(true);
    setProblem(null);

    let body = settingsPatch(settings, edits);
    if (body?.approvalMode === 'auto') {
      const fresh = await freshSettings(eventId);
      if (!fresh.ok) {
        stop(fresh.problem);
        return;
      }
      // Read against the settings as they are now: another phone may have switched already.
      body = settingsPatch(fresh.value, edits);
      const message =
        body?.approvalMode === 'auto'
          ? switchMessage(fresh.value.pendingCount, fresh.value.pendingPhotographers)
          : null;
      if (
        message !== null &&
        !(await ask(
          byPlatform('Turn Off Approval Mode?', 'Turn off approval mode?'),
          message,
          'Save',
        ))
      ) {
        setSaving(false);
        return;
      }
    }

    let waiting: string | null = null;
    if (body !== null) {
      const saved = await saveDetails(eventId, body);
      if (!saved.ok) {
        stop(saved.problem);
        return;
      }
      setEdits({});
      if (body.approvalMode === 'auto') {
        waiting = stillWaitingMessage(saved.value.admitted, saved.value.pendingCount);
      }
    }
    if (cover !== null) {
      const uploaded = await saveCover(eventId, cover, body !== null);
      if (!uploaded.ok) {
        stop(uploaded.problem);
        return;
      }
      setCover(null);
    }

    setSaving(false);
    setClosing(true);
    if (waiting !== null) {
      Alert.alert(
        byPlatform('Some Requests Are Still Waiting', 'Some requests are still waiting'),
        waiting,
      );
    }
  }

  const dates = event ? formatEventDates(new Date(event.startsAt), new Date(event.endsAt)) : null;
  const manual = shown?.approvalMode === 'manual';
  const note =
    settings && shown
      ? approvalNote(settings.approvalMode, shown.approvalMode, settings.pendingCount)
      : '';
  const approvalLabel = byPlatform('Approval Mode', 'Approval mode');

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <View className="items-center gap-3 py-24">
        <ActivityIndicator className="text-textSecondary" />
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          Loading the settings
        </Text>
      </View>
    );
  } else if (!settings || !shown) {
    body = (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center font-h2 text-h2 text-textPrimary">
          The settings could not be loaded
        </Text>
        <Text className="text-center font-body text-body text-textSecondary">
          Check the connection and try again.
        </Text>
        <Button
          label={query.isFetching ? 'Trying again' : byPlatform('Try Again', 'Try again')}
          variant="secondary"
          size="small"
          busy={query.isFetching}
          onPress={() => void query.refetch()}
        />
      </View>
    );
  } else {
    body = (
      <>
        {problem ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message={problem} />
          </View>
        ) : query.isError ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message="The settings could not be refreshed. They show what was loaded before." />
          </View>
        ) : null}
        <CoverField cover={cover} saved={settings.cover} onChange={setCover} disabled={saving} />
        <FieldGroup>
          <TextField
            label="Event name"
            value={shown.name}
            onChangeText={(name) => edit({ name })}
            autoCapitalize="words"
            returnKeyType="done"
            editable={!saving}
            error={problems.name}
          />
          <TextField
            label={byPlatform('Description (Optional)', 'Description (optional)')}
            placeholder="Tell guests what to expect"
            value={shown.description}
            onChangeText={(description) => edit({ description })}
            multiline
            editable={!saving}
            error={problems.description}
          />
        </FieldGroup>
        {/* iOS explains a switch in the section's footer, Android on the row's second line. */}
        <Section footer={IOS ? note : undefined}>
          <Row
            title={approvalLabel}
            subtitle={IOS ? undefined : note}
            trailing={
              <Toggle
                accessibilityLabel={approvalLabel}
                value={manual}
                disabled={saving}
                onValueChange={(on) => edit({ approvalMode: on ? 'manual' : 'auto' })}
              />
            }
          />
        </Section>
        <Section footer="The dates follow the first and last sub-events. Change them in the Schedule.">
          <Row
            title="Dates"
            {...(IOS ? { value: dates ?? undefined } : { subtitle: dates ?? undefined })}
            accessibilityLabel={dates ? `Dates, ${dates}` : 'Dates'}
            accessibilityHint="Opens the Schedule."
            chevron
            onPress={() => router.navigate(tabHref(eventId, 'schedule'))}
          />
        </Section>
      </>
    );
  }

  return (
    <SettingsFrame
      title={byPlatform('Event Settings', 'Event settings')}
      save={{ label: 'Save', onPress: () => void save(), disabled: !dirty, busy: saving }}
      onBack={() => router.back()}>
      {body}
    </SettingsFrame>
  );
}
