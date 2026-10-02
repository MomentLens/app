import { MAX_SUB_EVENTS } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section } from '@/components/ui/grouped';
import { useEventDraft } from '@/features/events/draft';
import { sortSubEvents } from '@/features/events/request';
import { DraftSubEventRow } from '@/features/events/draft-sub-event-row';
import { SubEventSheet, type SheetTarget } from '@/features/events/sub-event-sheet';
import { subEventsProblem } from '@/features/events/validation';
import { WizardFrame } from '@/features/events/wizard-frame';
import { byPlatform } from '@/lib/copy';

// Step 2: one to 15 sub-events, each added in the Add Sub-Event sheet and listed by start time.
// Next stays disabled until there is one, and there is no Skip (spec §2.1.2, D-111).
export default function SubEventsStep() {
  const router = useRouter();
  const subEvents = useEventDraft((state) => state.subEvents);
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const full = subEvents.length >= MAX_SUB_EVENTS;
  const problem = subEventsProblem(subEvents);

  return (
    <>
      <WizardFrame
        step={2}
        leading={{ kind: 'back', label: 'Back to basic info', onPress: () => router.back() }}
        primary={{
          label: 'Next',
          disabled: problem !== null,
          onPress: () => router.push('/events/new/review'),
        }}
        secondary={
          Platform.OS === 'android' ? { label: 'Back', onPress: () => router.back() } : undefined
        }>
        <Section
          header={`${byPlatform('Sub-Events', 'Sub-events')} · ${subEvents.length} of ${MAX_SUB_EVENTS}`}
          footer={
            subEvents.length === 0
              ? 'Add the parts of the event, such as the mehndi, the nikah and the walima. Each has its own time, venue and check-in radius.'
              : full
                ? `This event has ${MAX_SUB_EVENTS} sub-events, the most one can have.`
                : undefined
          }>
          {sortSubEvents(subEvents).map((subEvent, i) => (
            <DraftSubEventRow
              key={subEvent.key}
              subEvent={subEvent}
              number={i + 1}
              onPress={() => setTarget({ kind: 'edit', subEvent })}
            />
          ))}
          <Row
            leading={<Glyph name={GLYPH.add} size={22} tone="accentText" />}
            title={byPlatform('Add Sub-Event', 'Add sub-event')}
            action
            disabled={full}
            accessibilityHint={full ? `An event can have ${MAX_SUB_EVENTS} sub-events.` : undefined}
            onPress={() => setTarget({ kind: 'new' })}
          />
        </Section>
        {subEvents.length > 0 && problem ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message={problem} />
          </View>
        ) : null}
      </WizardFrame>
      <SubEventSheet target={target} onClose={() => setTarget(null)} />
    </>
  );
}
