import { VERIFICATION_RADIUS_DEFAULT_M, type SubEvent } from '@momentlens/shared-types';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { Alert, Text } from 'react-native';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { SubEventForm } from '@/features/events/sub-event-form';
import { defaultSubEventTimes } from '@/features/events/time';
import type { SubEventValues } from '@/features/events/validation';
import {
  addRequest,
  scheduleVenues,
  updateRequest,
  venueLeftUnused,
} from '@/features/schedule/schedule';
import { useSubEvents, writeSchedule } from '@/features/schedule/use-sub-events';
import { addSubEvent, deleteSubEvent, updateSubEvent } from '@/lib/api';

// Add carries the requestId made when the "+" opened the sheet, so every retry from this sheet
// sends the same one and adds the sub-event once (D-121). Edit carries the sub-event as the Admin
// saw it when the sheet opened.
export type ScheduleSheetTarget =
  { kind: 'add'; requestId: string } | { kind: 'edit'; subEvent: SubEvent };

export function addTarget(): ScheduleSheetTarget {
  return { kind: 'add', requestId: randomUUID() };
}

interface ScheduleSheetProps {
  eventId: string;
  target: ScheduleSheetTarget | null;
  onClose: () => void;
  // After a delete, so Sub-event Detail can close too.
  onDeleted?: () => void;
}

// The Admin's Add and Edit sheets on the Schedule (spec §2.5.5, D-121): the wizard's form, saved
// straight to the API. Edit holds Delete at its foot, as the design draws it (decided at build
// mobile).
export function ScheduleSheet({ eventId, target, onClose, onDeleted }: ScheduleSheetProps) {
  return (
    <Sheet target={target} onClose={onClose}>
      {(shown) => (
        <SheetContent eventId={eventId} target={shown} onClose={onClose} onDeleted={onDeleted} />
      )}
    </Sheet>
  );
}

function SheetContent({
  eventId,
  target,
  onClose,
  onDeleted,
}: {
  eventId: string;
  target: ScheduleSheetTarget;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const subEvents = useSubEvents(eventId).data?.subEvents ?? [];
  const original = target.kind === 'edit' ? target.subEvent : null;
  const [requestId, setRequestId] = useState(target.kind === 'add' ? target.requestId : null);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [initial] = useState(() => {
    if (original) {
      return {
        name: original.name,
        startsAt: new Date(original.startsAt),
        endsAt: new Date(original.endsAt),
        venue: {
          key: original.venue.id,
          name: original.venue.name,
          lat: original.venue.lat,
          lng: original.venue.lng,
        },
        radiusM: original.verificationRadiusM,
      };
    }
    const times = defaultSubEventTimes(
      subEvents.map((subEvent) => ({ endsAt: new Date(subEvent.endsAt) })),
      new Date(),
    );
    return { name: '', ...times, venue: null, radiusM: VERIFICATION_RADIUS_DEFAULT_M };
  });

  const venues = scheduleVenues(subEvents);
  const knownVenueIds = new Set(venues.map((venue) => venue.key));
  // The venue this sub-event leaves behind with nothing at it, which the same write deletes.
  const orphaned =
    original !== null && venueLeftUnused(subEvents, original.id, original.venue.id)
      ? original.venue.name
      : null;

  async function save(values: SubEventValues) {
    if (busy) return;
    let send;
    if (original) {
      const body = updateRequest(original, values, knownVenueIds);
      if (body === null) {
        onClose();
        return;
      }
      send = () => updateSubEvent(original.id, body);
    } else {
      const body = addRequest(requestId ?? randomUUID(), values, knownVenueIds);
      if (!body.success) {
        setProblem('Something in this sub-event could not be sent. Check each field.');
        return;
      }
      send = () => addSubEvent(eventId, body.data);
    }
    setBusy('save');
    setProblem(null);
    const failure = await writeSchedule(eventId, original ? 'edit' : 'add', send);
    setBusy(null);
    if (failure === null) {
      onClose();
      return;
    }
    // Another event's sub-event holds this requestId, so every retry with it would be refused the
    // same way. Nothing was added for this event, so a new one cannot add it twice.
    if (failure.code === 'duplicate') setRequestId(randomUUID());
    setProblem(failure.message);
  }

  async function remove(subEvent: SubEvent) {
    setBusy('delete');
    setProblem(null);
    const failure = await writeSchedule(eventId, 'delete', () => deleteSubEvent(subEvent.id));
    setBusy(null);
    if (failure === null) {
      onClose();
      onDeleted?.();
      return;
    }
    setProblem(failure.message);
  }

  function confirmDelete(subEvent: SubEvent) {
    const venueNote = orphaned
      ? ` No other sub-event is at ${orphaned}, so it is removed too, and its printed check-in QR stops working.`
      : '';
    Alert.alert(`Delete ${subEvent.name}?`, `This cannot be undone.${venueNote}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void remove(subEvent) },
    ]);
  }

  // The last sub-event cannot go: an event spans its sub-events (D-88). The server refuses it as
  // well, for a schedule this phone has not seen yet (D-121).
  const onlyOne = subEvents.length <= 1;

  return (
    <SubEventForm
      title={original ? 'Edit Sub-Event' : 'Add Sub-Event'}
      submitLabel={original ? 'Save Changes' : 'Add Sub-Event'}
      initial={initial}
      venues={venues}
      busy={busy === 'save'}
      problem={problem}
      venueNote={(venue) =>
        orphaned !== null && original !== null && venue !== null && venue.key !== original.venue.id
          ? `No other sub-event is at ${orphaned}. Moving this one removes it, and its printed check-in QR stops working.`
          : null
      }
      onClose={onClose}
      onSubmit={(values) => void save(values)}
      footer={
        original ? (
          <>
            <Button
              label="Delete Sub-Event"
              variant="destructive"
              icon="trash-2"
              busy={busy === 'delete'}
              disabled={onlyOne || busy === 'save'}
              accessibilityHint={onlyOne ? 'An event needs at least one sub-event.' : undefined}
              onPress={() => confirmDelete(original)}
            />
            {onlyOne ? (
              <Text className="text-center font-caption text-caption text-textSecondary">
                An event needs at least one sub-event, so its only one cannot be deleted.
              </Text>
            ) : null}
          </>
        ) : null
      }
    />
  );
}
