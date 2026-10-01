import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { useEvent } from '@/features/event-shell/use-event';
import { formatSubEventTimes } from '@/features/events/format';
import { FieldLabel } from '@/features/events/wizard-frame';
import { directionsUrl, romanNumeral, schedulePermissions } from '@/features/schedule/schedule';
import { ScheduleSheet, type ScheduleSheetTarget } from '@/features/schedule/schedule-sheet';
import { useSheetBottomPadding } from '@/features/schedule/sheet-inset';
import { useSubEvents } from '@/features/schedule/use-sub-events';

interface ActionRowProps {
  icon: IconName;
  label: string;
  onPress?: () => void;
  // Drawn but not pressable, for an action whose slice has not landed yet.
  disabledNote?: string;
}

function ActionRow({ icon, label, onPress, disabledNote }: ActionRowProps) {
  const disabled = disabledNote !== undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={disabled ? `${label}, ${disabledNote}` : label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-12 flex-row items-center gap-3 rounded-xl border border-border bg-surface px-4 active:bg-surfaceMuted ${disabled ? 'opacity-50' : ''}`}>
      <Icon name={icon} size={18} className="text-textSecondary" />
      <View className="flex-1 py-3">
        <Text className="font-body text-body text-textPrimary">{label}</Text>
        {disabledNote ? (
          <Text className="font-caption text-caption text-textSecondary">{disabledNote}</Text>
        ) : null}
      </View>
      {disabled ? null : <Icon name="chevron-right" size={16} className="text-textSecondary" />}
    </Pressable>
  );
}

interface SubEventDetailProps {
  eventId: string;
  subEventId: string;
}

// Sub-event Detail, a sheet over the Schedule as the Figma Sub-Event Detail frame draws it (spec
// §2.5.5): the name, times and venue, Get Directions, and View photos for every role but the
// Photographer. The Admin edits from here, and deletes from the foot of the Edit sheet (decided at
// build mobile). It reads the schedule the list already holds.
export function SubEventDetail({ eventId, subEventId }: SubEventDetailProps) {
  const router = useRouter();
  const bottom = useSheetBottomPadding();
  const event = useEvent(eventId);
  const schedule = useSubEvents(eventId);
  const [editing, setEditing] = useState<ScheduleSheetTarget | null>(null);
  const subEvents = schedule.data?.subEvents ?? [];
  const index = subEvents.findIndex((candidate) => candidate.id === subEventId);
  const subEvent = index === -1 ? undefined : subEvents[index];
  const role = event.data?.event.role;
  const can = role ? schedulePermissions(role) : { edit: false, viewPhotos: false };

  function close() {
    router.back();
  }

  function directions(venue: { lat: number; lng: number }) {
    Linking.openURL(directionsUrl(Platform.OS, venue)).catch(() => {
      Alert.alert('Maps could not be opened', 'Open your maps app and search for the venue.');
    });
  }

  // Home, filtered to this sub-event's chip, which S-13 reads (D-121). The sheet closes first, or
  // it would stay up over Home.
  function viewPhotos() {
    router.back();
    router.navigate({ pathname: '/event/[id]/home', params: { id: eventId, subEventId } });
  }

  let body;
  if (subEvent === undefined) {
    body = schedule.isPending ? (
      <View className="items-center py-10">
        <ActivityIndicator className="text-accent" />
      </View>
    ) : (
      <View className="gap-3">
        <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
          This sub-event is not on the schedule
        </Text>
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          It may have been deleted on another phone.
        </Text>
      </View>
    );
  } else {
    body = (
      <>
        <View className="gap-2">
          <View className="flex-row items-baseline gap-2">
            <Text className="font-fraunces-semibold text-h2 text-accentText">
              {romanNumeral(index + 1)}
            </Text>
            <Text accessibilityRole="header" className="flex-1 font-h1 text-h1 text-textPrimary">
              {subEvent.name}
            </Text>
          </View>
          <Text className="font-micro text-micro uppercase tracking-wider text-textSecondary">
            {formatSubEventTimes(new Date(subEvent.startsAt), new Date(subEvent.endsAt))}
          </Text>
          <View className="flex-row items-center gap-2 pt-1">
            <Icon name="map-pin" size={16} className="text-textSecondary" />
            <Text className="flex-1 font-body text-body text-textSecondary">
              {subEvent.venue.name}
            </Text>
          </View>
          {subEvent.description ? (
            <Text className="pt-1 font-bodySecondary text-bodySecondary text-textPrimary">
              {subEvent.description}
            </Text>
          ) : null}
        </View>

        <View className="gap-3">
          <Button
            label="Get Directions"
            icon="navigation"
            onPress={() => directions(subEvent.venue)}
          />
          {can.viewPhotos ? (
            <Button
              label="View photos from this session"
              variant="secondary"
              icon="images"
              onPress={viewPhotos}
            />
          ) : null}
        </View>

        {can.edit ? (
          <View className="gap-3 border-t border-border pt-5">
            <FieldLabel>Admin actions</FieldLabel>
            <ActionRow
              icon="qr-code"
              label="Show Venue Check-In QR"
              disabledNote="Coming in a later update"
            />
            <ActionRow
              icon="pencil"
              label="Edit Sub-Event"
              onPress={() => setEditing({ kind: 'edit', subEvent })}
            />
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View className="gap-5 bg-surface px-5 pt-4" style={{ paddingBottom: bottom }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={8}
        onPress={close}
        className="-ml-2 h-11 w-11 items-center justify-center">
        <Icon name="x" size={22} className="text-textSecondary" />
      </Pressable>
      {body}
      {can.edit ? (
        <ScheduleSheet
          eventId={eventId}
          target={editing}
          onClose={() => setEditing(null)}
          onDeleted={close}
        />
      ) : null}
    </View>
  );
}
