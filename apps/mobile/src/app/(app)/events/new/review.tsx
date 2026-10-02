import type { EventSummary } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, BackHandler, Platform, View } from 'react-native';

import { FormMessage } from '@/components/ui/form-message';
import { Row, Section } from '@/components/ui/grouped';
import { eventHref } from '@/features/event-shell/tabs';
import { uploadCover } from '@/features/events/cover';
import { markCreated, renewRequestId, useEventDraft } from '@/features/events/draft';
import { buildCreateEventRequest, sortSubEvents } from '@/features/events/request';
import { DraftSubEventRow } from '@/features/events/draft-sub-event-row';
import { SubEventSheet, type SheetTarget } from '@/features/events/sub-event-sheet';
import { EVENT_TYPE_LABEL } from '@/features/events/event-type';
import { rememberCover, rememberCreatedEvent } from '@/features/events/use-events';
import { subEventsProblem } from '@/features/events/validation';
import { WizardFrame } from '@/features/events/wizard-frame';
import { ApiError, createEvent } from '@/lib/api';
import { byPlatform } from '@/lib/copy';

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
    router.replace(eventHref(event.id, event.role));
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
    await sendCover(event);
  }

  function cancel() {
    Alert.alert(
      byPlatform('Discard This Event?', 'Discard this event?'),
      'What you have entered will be lost.',
      [
        { text: byPlatform('Keep Editing', 'Keep editing'), style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => router.dismissTo('/') },
      ],
    );
  }

  const coverStep = phase === 'coverFailed' || phase === 'uploadingCover';
  const created = draft.created;

  return (
    <>
      <WizardFrame
        step={3}
        leading={
          coverStep
            ? {
                kind: 'back',
                label: 'Back to sub-events',
                onPress: () => router.back(),
                disabled: true,
              }
            : {
                kind: 'back',
                label: 'Back to sub-events',
                onPress: () => router.back(),
                disabled: locked,
              }
        }
        primary={
          coverStep
            ? {
                label:
                  phase === 'uploadingCover' ? 'Uploading' : byPlatform('Try Again', 'Try again'),
                busy: phase === 'uploadingCover',
                onPress: () => void create(),
              }
            : {
                label:
                  phase === 'creating' ? 'Creating' : byPlatform('Create Event', 'Create event'),
                busy: phase === 'creating',
                onPress: () => void create(),
              }
        }
        secondary={
          coverStep
            ? {
                label: byPlatform('Skip Cover', 'Skip cover'),
                disabled: phase === 'uploadingCover',
                onPress: () => created && land(created),
              }
            : Platform.OS === 'android'
              ? { label: 'Cancel', disabled: locked, onPress: cancel }
              : undefined
        }>
        {problem ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message={problem} />
          </View>
        ) : null}

        <Section
          header={byPlatform('Basic Info', 'Basic info')}
          headerAction={
            locked ? undefined : { label: 'Edit', onPress: () => router.dismissTo('/events/new') }
          }>
          <Row
            leading={
              <View className="h-11 w-11 overflow-hidden rounded-[10px] bg-surfaceMuted">
                {draft.cover ? (
                  <Image
                    source={{ uri: draft.cover.uri }}
                    style={{ width: 44, height: 44 }}
                    contentFit="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : null}
              </View>
            }
            leadingWidth={44}
            title={draft.name.trim()}
            subtitle={draft.type ? EVENT_TYPE_LABEL[draft.type] : undefined}
          />
          {draft.description.trim() ? <Row subtitle={draft.description.trim()} /> : null}
          <Row title="Approval Mode" value={draft.approvalRequired ? 'On' : 'Off'} />
        </Section>

        <Section
          header={`${byPlatform('Sub-Events', 'Sub-events')} (${subEvents.length})`}
          headerAction={locked ? undefined : { label: 'Edit', onPress: () => router.back() }}>
          {subEvents.map((subEvent, i) => (
            <DraftSubEventRow
              key={subEvent.key}
              subEvent={subEvent}
              number={i + 1}
              onPress={locked ? undefined : () => setTarget({ kind: 'edit', subEvent })}
            />
          ))}
        </Section>

        {Platform.OS === 'ios' && !coverStep ? (
          <Section>
            <Row
              title={byPlatform('Discard Event', 'Discard event')}
              destructive
              center
              disabled={locked}
              onPress={cancel}
            />
          </Section>
        ) : null}
      </WizardFrame>
      <SubEventSheet target={target} onClose={() => setTarget(null)} />
    </>
  );
}
