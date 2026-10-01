import { VERIFICATION_RADIUS_DEFAULT_M } from '@momentlens/shared-types';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import {
  removeSubEvent,
  saveSubEvent,
  useEventDraft,
  type DraftSubEvent,
} from '@/features/events/draft';
import { draftVenues } from '@/features/events/request';
import { SubEventForm } from '@/features/events/sub-event-form';
import { defaultSubEventTimes } from '@/features/events/time';

export type SheetTarget = { kind: 'new' } | { kind: 'edit'; subEvent: DraftSubEvent };

interface SubEventSheetProps {
  // What the sheet is open on, or null while it is closed.
  target: SheetTarget | null;
  onClose: () => void;
}

// The Add Sub-Event sheet on step 2 (spec §2.1.2, D-111). The pencil reopens it on a sub-event
// already added. Saving writes to the draft only; nothing reaches the API until step 3.
export function SubEventSheet({ target, onClose }: SubEventSheetProps) {
  return (
    <Sheet target={target} onClose={onClose}>
      {(shown) => <SheetContent target={shown} onClose={onClose} />}
    </Sheet>
  );
}

function SheetContent({ target, onClose }: { target: SheetTarget; onClose: () => void }) {
  const subEvents = useEventDraft((state) => state.subEvents);
  const editing = target.kind === 'edit' ? target.subEvent : null;
  const [initial] = useState(() => {
    const times = editing ?? defaultSubEventTimes(subEvents, new Date());
    return {
      name: editing?.name ?? '',
      startsAt: times.startsAt,
      endsAt: times.endsAt,
      venue: editing?.venue ?? null,
      radiusM: editing?.radiusM ?? VERIFICATION_RADIUS_DEFAULT_M,
    };
  });

  return (
    <SubEventForm
      title={editing ? 'Edit Sub-Event' : 'Add Sub-Event'}
      submitLabel={editing ? 'Save Sub-Event' : 'Add Sub-Event'}
      initial={initial}
      // Venues the other sub-events use. This one's own, if no other uses it, the form adds back.
      venues={draftVenues(subEvents.filter((subEvent) => subEvent.key !== editing?.key))}
      onClose={onClose}
      onSubmit={(values) => {
        saveSubEvent({ key: editing?.key ?? randomUUID(), ...values });
        onClose();
      }}
      footer={
        editing ? (
          <Button
            label="Remove sub-event"
            variant="quiet"
            onPress={() => {
              removeSubEvent(editing.key);
              onClose();
            }}
          />
        ) : null
      }
    />
  );
}
