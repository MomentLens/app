import { currentSubEvent, MAX_SUB_EVENTS, subEventStatus } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_ICON_SIZE, HEADER_SLOT } from '@/components/ui/app-header';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { useEvent } from '@/features/event-shell/use-event';
import { formatDay, formatEventDates } from '@/features/events/format';
import { LiveCard } from '@/features/schedule/live-card';
import { DelaySheet } from '@/features/schedule/delay-sheet';
import { nextStatusChange, scheduleDays, schedulePermissions } from '@/features/schedule/schedule';
import { ScheduleRow } from '@/features/schedule/schedule-row';
import {
  addTarget,
  ScheduleSheet,
  type ScheduleSheetTarget,
} from '@/features/schedule/schedule-sheet';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useNow } from '@/hooks/use-now';
import { usePullRefresh } from '@/hooks/use-pull-refresh';
import { BottomTabInset } from '@/lib/platform';

const NO_PERMISSIONS = { edit: false, viewPhotos: false };

// The Schedule tab, one list for every role, gated rather than forked (spec §2.5.5): the sub-event
// running now, then every sub-event by start with its status, which moves on by itself at each
// start and end. The Admin adds from the header and delays from each row; edit and delete live in
// Sub-event Detail. It reads a persisted copy, so it opens offline (D-118, D-121).
export function ScheduleScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const event = useEvent(eventId);
  const schedule = useSubEvents(eventId);
  const pull = usePullRefresh(schedule.refetch);
  const subEvents = schedule.data?.subEvents;
  const now = useNow(
    useCallback((at: Date) => (subEvents ? nextStatusChange(subEvents, at) : null), [subEvents]),
  );
  const can = event.data ? schedulePermissions(event.data.event.role) : NO_PERMISSIONS;
  const [sheet, setSheet] = useState<ScheduleSheetTarget | null>(null);
  const [delaying, setDelaying] = useState<string | null>(null);

  const days = useMemo(() => (subEvents ? scheduleDays(subEvents) : []), [subEvents]);
  const live = subEvents ? currentSubEvent(subEvents, now) : null;
  const full = (subEvents?.length ?? 0) >= MAX_SUB_EVENTS;
  // The event's span, first start to last end, as the Events tab shows it (D-88).
  const span = subEvents
    ? formatEventDates(
        new Date(Math.min(...subEvents.map((subEvent) => Date.parse(subEvent.startsAt)))),
        new Date(Math.max(...subEvents.map((subEvent) => Date.parse(subEvent.endsAt)))),
      )
    : null;

  function open(subEventId: string) {
    router.push({
      pathname: '/event/[id]/schedule/[subEventId]',
      params: { id: eventId, subEventId },
    });
  }

  // Home, filtered to this sub-event's chip, which S-13 reads (D-121).
  function viewPhotos(subEventId: string) {
    router.navigate({ pathname: '/event/[id]/home', params: { id: eventId, subEventId } });
  }

  // iOS's tab bar lies over the content, so the list ends above it. Android's sits below.
  const overTabBar = Platform.OS === 'ios' ? insets.bottom + BottomTabInset : 0;

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="flex-grow gap-4 px-4 pt-2"
        contentContainerStyle={{ paddingBottom: overTabBar + 24 }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}>
        <View className="flex-row items-end justify-between gap-3">
          <View className="flex-1 gap-1">
            {span ? (
              <Text className="font-micro text-micro uppercase tracking-wider text-textSecondary">
                {span}
              </Text>
            ) : null}
            <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
              Schedule
            </Text>
          </View>
          {can.edit ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a sub-event"
              accessibilityHint={
                full ? `An event can have ${MAX_SUB_EVENTS} sub-events.` : undefined
              }
              accessibilityState={{ disabled: full || !subEvents }}
              disabled={full || !subEvents}
              hitSlop={4}
              onPress={() => setSheet(addTarget())}
              className={`${HEADER_SLOT} items-center justify-center rounded-full bg-surfaceMuted active:bg-border ${full || !subEvents ? 'opacity-40' : ''}`}>
              <Icon name="plus" size={HEADER_ICON_SIZE} className="text-textPrimary" />
            </Pressable>
          ) : null}
        </View>

        {can.edit && full ? (
          <Text className="font-caption text-caption text-textSecondary">
            This event has {MAX_SUB_EVENTS} sub-events, the most one can have.
          </Text>
        ) : null}

        {schedule.isError && schedule.data ? (
          <FormMessage message="The schedule could not be refreshed. It shows what was loaded before." />
        ) : null}

        {schedule.isPending ? (
          <View className="flex-1 items-center justify-center gap-3 py-16">
            <ActivityIndicator className="text-accent" />
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              Loading the schedule
            </Text>
          </View>
        ) : schedule.isError && !schedule.data ? (
          <View className="flex-1 items-center justify-center gap-4 py-16">
            <Text className="text-center font-h2 text-h2 text-textPrimary">
              The schedule could not be loaded
            </Text>
            <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
              Check the connection and try again.
            </Text>
            <Button
              label={schedule.isFetching ? 'Trying again' : 'Try again'}
              variant="secondary"
              busy={schedule.isFetching}
              onPress={() => void schedule.refetch()}
            />
          </View>
        ) : (
          <>
            {live ? (
              <LiveCard
                subEvent={live}
                onOpen={() => open(live.id)}
                onViewPhotos={can.viewPhotos ? () => viewPhotos(live.id) : undefined}
              />
            ) : null}
            {days.map((day) => (
              <View key={day.key} className="gap-2">
                {days.length > 1 ? (
                  <Text
                    accessibilityRole="header"
                    className="px-1 font-micro text-micro uppercase tracking-wider text-textSecondary">
                    {formatDay(new Date(day.entries[0]!.subEvent.startsAt))}
                  </Text>
                ) : null}
                <View className="overflow-hidden rounded-2xl border border-border bg-surface">
                  {day.entries.map(({ subEvent, number }, i) => (
                    <ScheduleRow
                      key={subEvent.id}
                      subEvent={subEvent}
                      number={number}
                      status={subEventStatus(subEvent, now)}
                      first={i === 0}
                      onOpen={() => open(subEvent.id)}
                      onDelay={can.edit ? () => setDelaying(subEvent.id) : undefined}
                    />
                  ))}
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      {can.edit ? (
        <>
          <ScheduleSheet eventId={eventId} target={sheet} onClose={() => setSheet(null)} />
          <DelaySheet
            eventId={eventId}
            subEventId={delaying}
            now={now}
            onClose={() => setDelaying(null)}
          />
        </>
      ) : null}
    </View>
  );
}
