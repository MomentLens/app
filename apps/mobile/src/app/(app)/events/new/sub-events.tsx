import { MAX_SUB_EVENTS } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { useEventDraft } from '@/features/events/draft';
import { sortSubEvents } from '@/features/events/request';
import { SubEventCard } from '@/features/events/sub-event-card';
import { SubEventSheet, type SheetTarget } from '@/features/events/sub-event-sheet';
import { subEventsProblem } from '@/features/events/validation';
import { WizardFrame } from '@/features/events/wizard-frame';

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
        title="Sub-Events"
        back={{ icon: 'chevron-left', label: 'Back to basic info', onPress: () => router.back() }}
        footer={
          <Button
            label="Next"
            disabled={problem !== null}
            accessibilityHint={problem ?? undefined}
            onPress={() => router.push('/events/new/review')}
          />
        }>
        <View className="flex-row items-center justify-between">
          <Text className="font-caption text-caption text-textSecondary">
            {subEvents.length === 1 ? '1 sub-event added' : `${subEvents.length} sub-events added`}
          </Text>
          <Text className="font-caption text-caption text-accentText">Max {MAX_SUB_EVENTS}</Text>
        </View>
        <Button
          label="Add Sub-Event"
          variant="secondary"
          icon="plus"
          disabled={full}
          accessibilityHint={full ? `An event can have ${MAX_SUB_EVENTS} sub-events.` : undefined}
          onPress={() => setTarget({ kind: 'new' })}
        />
        {full ? (
          <Text className="font-caption text-caption text-textSecondary">
            This event has {MAX_SUB_EVENTS} sub-events, the most one can have.
          </Text>
        ) : null}
        {sortSubEvents(subEvents).map((subEvent) => (
          <SubEventCard
            key={subEvent.key}
            subEvent={subEvent}
            onEdit={() => setTarget({ kind: 'edit', subEvent })}
          />
        ))}
        {subEvents.length === 0 ? (
          <Text className="py-6 text-center font-bodySecondary text-bodySecondary text-textSecondary">
            Add the parts of the event, such as the mehndi, the nikkah and the walima. Each has its
            own time, venue and check-in radius.
          </Text>
        ) : problem ? (
          <FormMessage message={problem} />
        ) : null}
      </WizardFrame>
      <SubEventSheet target={target} onClose={() => setTarget(null)} />
    </>
  );
}
