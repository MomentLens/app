import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { useEvent } from '@/features/event-shell/use-event';
import { formatSubEventTimes } from '@/features/events/format';
import { directionsUrl, romanNumeral, schedulePermissions } from '@/features/schedule/schedule';
import { ScheduleSheet, type ScheduleSheetTarget } from '@/features/schedule/schedule-sheet';
import { useSheetBottomPadding } from '@/features/schedule/sheet-inset';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { byPlatform } from '@/lib/copy';

interface SubEventDetailProps {
  eventId: string;
  subEventId: string;
}

// Sub-event Detail, a sheet over the whole Event shell (spec §2.5.5, D-125, D-127): which one of
// how many, the name, times and venue, Directions and Photos side by side, and for the Admin, Edit
// in the toolbar with Delay and the venue's check-in QR as rows. A Photographer, who has no Home,
// gets Directions alone. Delete is at the foot of the Edit sheet (D-121). It reads the schedule
// the list already holds.
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

  function delay() {
    router.push({
      pathname: '/sub-event/[eventId]/[subEventId]/delay',
      params: { eventId, subEventId },
    });
  }

  let body;
  if (subEvent === undefined) {
    body = schedule.isPending ? (
      <View className="items-center py-10">
        <ActivityIndicator className="text-textSecondary" />
      </View>
    ) : (
      <View className="gap-2 px-5">
        <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
          This sub-event is not on the schedule
        </Text>
        <Text className="font-body text-body text-textSecondary">
          It may have been deleted on another phone.
        </Text>
      </View>
    );
  } else {
    body = (
      <>
        <View className="gap-3 px-5">
          <View className="gap-1">
            <Text className="font-caption text-caption text-textSecondary">
              Sub-event {romanNumeral(index + 1)} of {romanNumeral(subEvents.length)}
            </Text>
            <Text accessibilityRole="header" className="font-h1 text-h1 text-textPrimary">
              {subEvent.name}
            </Text>
          </View>
          <View className="gap-2">
            <View className="flex-row items-center gap-2.5">
              <Icon name="calendar" size={18} className="text-textSecondary" />
              <Text className="flex-1 font-body text-body text-textPrimary">
                {formatSubEventTimes(new Date(subEvent.startsAt), new Date(subEvent.endsAt))}
              </Text>
            </View>
            <View className="flex-row items-center gap-2.5">
              <Icon name="map-pin" size={18} className="text-textSecondary" />
              <Text className="flex-1 font-body text-body text-textPrimary">
                {subEvent.venue.name}
              </Text>
            </View>
          </View>
          {subEvent.description ? (
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              {subEvent.description}
            </Text>
          ) : null}
          <View className="flex-row gap-3 pt-2">
            <View className="flex-1">
              <Button
                label={byPlatform('Directions', 'Directions')}
                icon="navigation"
                onPress={() => directions(subEvent.venue)}
              />
            </View>
            {can.viewPhotos ? (
              <View className="flex-1">
                <Button label="Photos" icon="images" variant="secondary" onPress={viewPhotos} />
              </View>
            ) : null}
          </View>
        </View>

        {can.edit ? (
          <Section>
            <Row
              leading={<Glyph name={GLYPH.delay} size={22} tone="textSecondary" />}
              title={byPlatform('Delay…', 'Delay')}
              chevron
              onPress={delay}
            />
            <Row
              leading={<Glyph name={GLYPH.qr} size={22} tone="textSecondary" />}
              title={byPlatform('Venue Check-In QR', 'Venue check-in QR')}
              value="Coming soon"
              disabled
            />
          </Section>
        ) : null}
      </>
    );
  }

  return (
    <View collapsable={false} className="gap-4 bg-background" style={{ paddingBottom: bottom }}>
      <SheetHandle />
      <SheetToolbar
        onClose={close}
        confirm={
          can.edit && subEvent
            ? {
                label: 'Edit',
                kind: 'action',
                glyph: GLYPH.edit,
                onPress: () => setEditing({ kind: 'edit', subEvent }),
              }
            : undefined
        }
      />
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
