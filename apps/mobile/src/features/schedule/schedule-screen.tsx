import {
  currentSubEvent,
  MAX_SUB_EVENTS,
  subEventStatus,
  type SubEvent,
} from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  Text,
  View,
} from 'react-native';

import type { MenuItem } from '@/components/ui/anchored-menu';
import { Button } from '@/components/ui/button';
import { Fab } from '@/components/ui/fab';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH } from '@/components/ui/glyph';
import { Section, SectionGap } from '@/components/ui/grouped';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';
import { useEvent } from '@/features/event-shell/use-event';
import { formatDay } from '@/features/events/format';
import { LiveCard } from '@/features/schedule/live-card';
import {
  delayShortcuts,
  directionsUrl,
  nextStatusChange,
  scheduleDays,
  schedulePermissions,
} from '@/features/schedule/schedule';
import { ScheduleRow } from '@/features/schedule/schedule-row';
import {
  addTarget,
  ScheduleSheet,
  type ScheduleSheetTarget,
} from '@/features/schedule/schedule-sheet';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useNow } from '@/hooks/use-now';
import { usePullRefresh } from '@/hooks/use-pull-refresh';
import { byPlatform } from '@/lib/copy';

const NO_PERMISSIONS = { edit: false, viewPhotos: false };

// The FAB's 56dp and the 16 below it, which the end of the list scrolls clear of.
const FAB_CLEARANCE = 56 + 16;

// The Schedule tab, one list for every role, gated rather than forked (spec §2.5.5): the sub-event
// running now on the Live card, then every sub-event by day as a timeline with its status, which
// moves on by itself at each start and end. The Admin adds from the bar on iOS and the FAB on
// Android, and delays from the Live card, the next sub-event's row, any row's menu or Detail
// (D-127). It reads a persisted copy, so it opens offline (D-118, D-121).
export function ScheduleScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const event = useEvent(eventId);
  const schedule = useSubEvents(eventId);
  const pull = usePullRefresh(schedule.refetch);
  const subEvents = schedule.data?.subEvents;
  const now = useNow(
    useCallback((at: Date) => (subEvents ? nextStatusChange(subEvents, at) : null), [subEvents]),
  );
  const can = event.data ? schedulePermissions(event.data.event.role) : NO_PERMISSIONS;
  const [sheet, setSheet] = useState<ScheduleSheetTarget | null>(null);

  const days = useMemo(() => (subEvents ? scheduleDays(subEvents) : []), [subEvents]);
  const numbers = useMemo(
    () =>
      new Map(
        days.flatMap((day) =>
          day.entries.map((entry) => [entry.subEvent.id, entry.number] as const),
        ),
      ),
    [days],
  );
  const live = subEvents ? currentSubEvent(subEvents, now) : null;
  const shortcuts = subEvents ? delayShortcuts(subEvents, now) : { live: null, next: null };
  const full = (subEvents?.length ?? 0) >= MAX_SUB_EVENTS;
  const canAdd = can.edit && subEvents !== undefined && !full;

  function detail(subEventId: string) {
    return {
      pathname: '/sub-event/[eventId]/[subEventId]',
      params: { eventId, subEventId },
    } as const;
  }

  function open(subEventId: string) {
    router.push(detail(subEventId));
  }

  function delay(subEventId: string) {
    router.push({
      pathname: '/sub-event/[eventId]/[subEventId]/delay',
      params: { eventId, subEventId },
    });
  }

  // Home, filtered to this sub-event's chip, which S-13 reads (D-121).
  function viewPhotos(subEventId: string) {
    router.navigate({ pathname: '/event/[id]/home', params: { id: eventId, subEventId } });
  }

  function directions(subEvent: SubEvent) {
    Linking.openURL(directionsUrl(Platform.OS, subEvent.venue)).catch(() => {
      Alert.alert('Maps could not be opened', 'Open your maps app and search for the venue.');
    });
  }

  // The long-press menu, in the order Sub-event Detail shows the same actions (D-127). Delete is
  // not in it; it stays at the foot of the Edit sheet.
  function menu(subEvent: SubEvent): MenuItem[] {
    const items: MenuItem[] = [];
    if (can.edit) {
      items.push(
        {
          key: 'delay',
          label: byPlatform('Delay…', 'Delay'),
          glyph: GLYPH.delay,
          onPress: () => delay(subEvent.id),
        },
        {
          key: 'edit',
          label: 'Edit',
          glyph: GLYPH.edit,
          onPress: () => setSheet({ kind: 'edit', subEvent }),
        },
      );
    }
    items.push({
      key: 'directions',
      label: byPlatform('Get Directions', 'Directions'),
      glyph: GLYPH.directions,
      onPress: () => directions(subEvent),
    });
    if (can.viewPhotos) {
      items.push({
        key: 'photos',
        label: byPlatform('View Photos', 'View photos'),
        glyph: GLYPH.photos,
        onPress: () => viewPhotos(subEvent.id),
      });
    }
    return items;
  }

  let body: ReactNode;
  if (schedule.isPending) {
    body = (
      <View className="items-center gap-3 py-24">
        <ActivityIndicator className="text-textSecondary" />
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          Loading the schedule
        </Text>
      </View>
    );
  } else if (schedule.isError && !schedule.data) {
    body = (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center font-h2 text-h2 text-textPrimary">
          The schedule could not be loaded
        </Text>
        <Text className="text-center font-body text-body text-textSecondary">
          Check the connection and try again.
        </Text>
        <Button
          label={schedule.isFetching ? 'Trying again' : byPlatform('Try Again', 'Try again')}
          variant="secondary"
          size="small"
          busy={schedule.isFetching}
          onPress={() => void schedule.refetch()}
        />
      </View>
    );
  } else {
    body = (
      <View className="gap-6 pt-2">
        {schedule.isError ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message="The schedule could not be refreshed. It shows what was loaded before." />
          </View>
        ) : null}
        {live ? (
          <LiveCard
            subEvent={live}
            number={numbers.get(live.id) ?? 1}
            onOpen={() => open(live.id)}
            onViewPhotos={can.viewPhotos ? () => viewPhotos(live.id) : undefined}
            onDelay={can.edit ? () => delay(live.id) : undefined}
          />
        ) : null}
        {days.map((day) => (
          <Section
            key={day.key}
            header={
              days.length > 1 ? formatDay(new Date(day.entries[0]!.subEvent.startsAt)) : undefined
            }>
            {day.entries.map(({ subEvent, number }) => (
              <ScheduleRow
                key={subEvent.id}
                subEvent={subEvent}
                number={number}
                status={subEventStatus(subEvent, now)}
                href={detail(subEvent.id)}
                delayButton={can.edit && shortcuts.next === subEvent.id}
                onDelay={can.edit ? () => delay(subEvent.id) : undefined}
                menu={menu(subEvent)}
              />
            ))}
          </Section>
        ))}
        {can.edit && full ? (
          <Text className="px-9 font-caption text-caption text-textSecondary">
            This event has {MAX_SUB_EVENTS} sub-events, the most one can have.
          </Text>
        ) : null}
        <SectionGap />
      </View>
    );
  }

  const fab = Platform.OS === 'android' && canAdd;

  return (
    <EventTabScreen
      actions={
        Platform.OS === 'ios' && can.edit
          ? [
              {
                key: 'add',
                label: 'Add a sub-event',
                glyph: GLYPH.add,
                disabled: !canAdd,
                onPress: () => setSheet(addTarget()),
              },
            ]
          : undefined
      }
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      bottomInset={fab ? FAB_CLEARANCE : 0}
      overlay={
        <>
          {fab ? (
            <Fab
              icon="plus"
              label="Add a sub-event"
              onPress={() => setSheet(addTarget())}
              bottom={16}
            />
          ) : null}
          {can.edit ? (
            <ScheduleSheet eventId={eventId} target={sheet} onClose={() => setSheet(null)} />
          ) : null}
        </>
      }>
      {body}
    </EventTabScreen>
  );
}
