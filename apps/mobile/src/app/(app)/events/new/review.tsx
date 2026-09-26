import { eventTiming, type EventSummary } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Alert, BackHandler, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextLink } from '@/components/ui/text-link';
import { uploadCover } from '@/features/events/cover';
import { markCreated, renewRequestId, useEventDraft } from '@/features/events/draft';
import { buildCreateEventRequest, sortSubEvents } from '@/features/events/request';
import { SubEventCard } from '@/features/events/sub-event-card';
import { SubEventSheet, type SheetTarget } from '@/features/events/sub-event-sheet';
import { showEventsTab } from '@/features/events/tab-store';
import { EVENT_TYPE_LABEL } from '@/features/events/type-select';
import { rememberCover, rememberCreatedEvent } from '@/features/events/use-events';
import { subEventsProblem } from '@/features/events/validation';
import { WizardFrame } from '@/features/events/wizard-frame';
import { ApiError, createEvent } from '@/lib/api';

type Phase = 'review' | 'creating' | 'uploadingCover' | 'coverFailed';

// What the user reads when POST /events fails. A retry sends the same requestId, so it never
// makes a second event (D-110), and the message says so where that is the worry.
function createProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === undefined) {
      return 'MomentLens could not be reached. Check the connection and try again. Trying again will not create the event twice.';
    }
    if (error.code === 'invalid_request') {
      return 'MomentLens refused these details. Check each sub-event and try again.';
    }
    if (error.code === 'duplicate') {
      return 'Something went wrong. Try again.';
    }
    if (error.status === 401) {
      return 'Your sign-in could not be confirmed. Try again.';
    }
  }
  return 'Something went wrong on our side. Try again in a moment.';
}

function Card({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit?: () => void;
  children: ReactNode;
}) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center justify-between">
        <Text
          accessibilityRole="header"
          className="font-fieldLabel text-fieldLabel text-textPrimary">
          {title}
        </Text>
        {onEdit ? <TextLink label="Edit" onPress={onEdit} /> : null}
      </View>
      {children}
    </View>
  );
}

// Step 3: review and confirm (spec §2.1.2). Create sends the whole draft in one POST /events,
// then uploads the cover if there is one. The event exists from the moment the POST answers, so a
// failed cover leaves an event without one (D-110) and offers to try the cover again.
export default function ReviewStep() {
  const router = useRouter();
  const draft = useEventDraft();
  const [phase, setPhase] = useState<Phase>(draft.created ? 'coverFailed' : 'review');
  const [problem, setProblem] = useState<string | null>(null);
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const subEvents = sortSubEvents(draft.subEvents);
  const locked = phase !== 'review';

  // Nothing may leave the step while a create is in flight or once the event exists, since a
  // repeat with this requestId returns the first event and ignores any edit.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => locked);
      return () => subscription.remove();
    }, [locked]),
  );

  function land(event: EventSummary) {
    router.replace({ pathname: '/event/[id]', params: { id: event.id } });
  }

  async function sendCover(event: EventSummary) {
    const cover = useEventDraft.getState().cover;
    if (cover === null) {
      land(event);
      return;
    }
    setPhase('uploadingCover');
    setProblem(null);
    try {
      rememberCover(event.id, await uploadCover(event.id, cover));
      land(event);
    } catch {
      setPhase('coverFailed');
      setProblem('The event is created, but its cover did not upload.');
    }
  }

  async function create() {
    const created = useEventDraft.getState().created;
    if (created) {
      await sendCover(created);
      return;
    }
    const body = buildCreateEventRequest(useEventDraft.getState());
    if (!body.success) {
      setProblem(
        subEventsProblem(useEventDraft.getState().subEvents) ??
          'Something in the earlier steps needs fixing before the event can be created.',
      );
      return;
    }
    setPhase('creating');
    setProblem(null);
    let event: EventSummary;
    try {
      ({ event } = await createEvent(body.data));
    } catch (error) {
      // Another account holds this requestId, so the retry needs its own (D-110).
      if (error instanceof ApiError && error.code === 'duplicate') renewRequestId();
      setPhase('review');
      setProblem(createProblem(error));
      return;
    }
    markCreated(event);
    rememberCreatedEvent(event);
    showEventsTab(eventTiming(event, new Date()));
    await sendCover(event);
  }

  function cancel() {
    Alert.alert('Discard this event?', 'What you have entered will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.dismissTo('/') },
    ]);
  }

  const footer =
    phase === 'coverFailed' || phase === 'uploadingCover' ? (
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Skip cover"
            variant="secondary"
            disabled={phase === 'uploadingCover'}
            onPress={() => draft.created && land(draft.created)}
          />
        </View>
        <View className="flex-1">
          <Button
            label={phase === 'uploadingCover' ? 'Uploading' : 'Try again'}
            busy={phase === 'uploadingCover'}
            onPress={() => void create()}
          />
        </View>
      </View>
    ) : (
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button label="Cancel" variant="secondary" disabled={locked} onPress={cancel} />
        </View>
        <View className="flex-1">
          <Button
            label={phase === 'creating' ? 'Creating' : 'Create Event'}
            busy={phase === 'creating'}
            onPress={() => void create()}
          />
        </View>
      </View>
    );

  return (
    <>
      <WizardFrame
        step={3}
        title="Review & Confirm"
        back={{
          icon: 'chevron-left',
          label: 'Back to sub-events',
          onPress: () => router.back(),
          disabled: locked,
        }}
        footer={footer}>
        {problem ? <FormMessage message={problem} /> : null}

        <Card
          title="Basic Info"
          onEdit={locked ? undefined : () => router.dismissTo('/events/new')}>
          <View className="flex-row items-center gap-3">
            <View className="h-14 w-14 overflow-hidden rounded-lg bg-surfaceMuted">
              {draft.cover ? (
                <Image
                  source={{ uri: draft.cover.uri }}
                  style={{ width: 56, height: 56 }}
                  contentFit="cover"
                  accessibilityIgnoresInvertColors
                />
              ) : null}
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="font-fieldLabel text-fieldLabel text-textPrimary">
                {draft.name.trim()}
              </Text>
              <Text className="font-caption text-caption text-textSecondary">
                {draft.type ? EVENT_TYPE_LABEL[draft.type] : ''}
              </Text>
            </View>
          </View>
          {draft.description.trim() ? (
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              {draft.description.trim()}
            </Text>
          ) : null}
          <Text className="font-caption text-caption text-textSecondary">
            {draft.approvalRequired
              ? 'Approval Mode on: you approve each new member.'
              : 'Approval Mode off: anyone with an invite joins straight away.'}
          </Text>
        </Card>

        <Card
          title={`Sub-Events (${subEvents.length})`}
          onEdit={locked ? undefined : () => router.back()}>
          {subEvents.map((subEvent) => (
            <SubEventCard
              key={subEvent.key}
              subEvent={subEvent}
              onEdit={() => !locked && setTarget({ kind: 'edit', subEvent })}
            />
          ))}
        </Card>
      </WizardFrame>
      <SubEventSheet target={target} onClose={() => setTarget(null)} />
    </>
  );
}
