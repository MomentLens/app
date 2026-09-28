import type { EventTiming } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_AVATAR_SIZE } from '@/components/ui/app-header';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Fab } from '@/components/ui/fab';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { BottomTabInset } from '@/constants/theme';
import { EventCard } from '@/features/events/event-card';
import { groupByTiming } from '@/features/events/list';
import { showEventsTab, useEventsTab } from '@/features/events/tab-store';
import { TimingTabs } from '@/features/events/timing-tabs';
import { useCreateEvent } from '@/features/events/use-create-event';
import { useEvents } from '@/features/events/use-events';
import { useTimingNow } from '@/features/events/use-timing-now';
import { usePullRefresh } from '@/hooks/use-pull-refresh';
import { CREATE_IN_TAB_BAR } from '@/lib/platform';

// The FAB's 56 points and the 16 below it, which the end of the list scrolls clear of.
const FAB_CLEARANCE = 56 + 16;

const EMPTY_TAB: Record<EventTiming, { title: string; body: string }> = {
  active: {
    title: 'Nothing on right now',
    body: 'An event shows here from its first sub-event to its last.',
  },
  upcoming: {
    title: 'Nothing coming up',
    body: 'Events you have joined that have not started yet show here.',
  },
  past: { title: 'No past events', body: 'Events show here once their last sub-event ends.' },
};

// The Events tab, the Global shell's landing screen (spec §2.5.1). It lists every event where the
// caller's membership is active, sorted into Active, Upcoming and Past by span (D-110).
export function EventsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tab = useEventsTab((state) => state.tab);
  const events = useEvents();
  const pull = usePullRefresh(events.refetch);
  const createEvent = useCreateEvent();
  const now = useTimingNow(events.data?.events);
  const groups = useMemo(
    () => (events.data ? groupByTiming(events.data.events, now) : null),
    [events.data, now],
  );

  // iOS's tab bar lies over the content, so the list and the FAB start above it. Android's sits
  // below the content, which already ends at the bar.
  const overTabBar = Platform.OS === 'ios' ? insets.bottom + BottomTabInset : 0;
  const fabBottom = overTabBar + 16;

  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'left', 'right']}>
        <View className="gap-4 px-4 pb-3">
          <AppHeader
            left={{ icon: 'bell', label: 'Notifications, coming soon', disabled: true }}
            right={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Profile"
                hitSlop={8}
                onPress={() => router.navigate('/profile')}>
                <Avatar size={HEADER_AVATAR_SIZE} />
              </Pressable>
            }
          />
          <TimingTabs value={tab} onChange={showEventsTab} />
        </View>

        <ScrollView
          contentContainerClassName="flex-grow gap-3 px-4 pt-1"
          contentContainerStyle={{
            paddingBottom: fabBottom + (CREATE_IN_TAB_BAR ? 0 : FAB_CLEARANCE),
          }}
          refreshControl={
            <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
          }>
          {events.isError && events.data ? (
            <FormMessage message="The list could not be refreshed. It shows what was loaded before." />
          ) : null}

          {events.isPending ? (
            <View className="flex-1 items-center justify-center gap-3 py-16">
              <ActivityIndicator className="text-accent" />
              <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                Loading your events
              </Text>
            </View>
          ) : events.isError && !events.data ? (
            <View className="flex-1 items-center justify-center gap-4 py-16">
              <Text className="text-center font-h2 text-h2 text-textPrimary">
                Your events could not be loaded
              </Text>
              <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
                Check the connection and try again.
              </Text>
              <Button
                label={events.isFetching ? 'Trying again' : 'Try again'}
                variant="secondary"
                busy={events.isFetching}
                onPress={() => void events.refetch()}
              />
            </View>
          ) : groups && events.data.events.length === 0 ? (
            <NoEvents onCreate={createEvent} />
          ) : groups && groups[tab].length === 0 ? (
            <View className="items-center gap-2 py-16">
              <Text className="text-center font-h2 text-h2 text-textPrimary">
                {EMPTY_TAB[tab].title}
              </Text>
              <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
                {EMPTY_TAB[tab].body}
              </Text>
            </View>
          ) : (
            groups?.[tab].map((event) => (
              <EventCard
                key={event.id}
                event={event}
                onPress={() => router.push({ pathname: '/event/[id]', params: { id: event.id } })}
              />
            ))
          )}
        </ScrollView>

        {CREATE_IN_TAB_BAR ? null : (
          <Fab icon="plus" label="Create an event" onPress={createEvent} bottom={fabBottom} />
        )}
      </SafeAreaView>
    </View>
  );
}

// The Figma "event-tab" frame: someone with no events at all. Joining by code arrives with S-03.
function NoEvents({ onCreate }: { onCreate: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-6 px-4 py-12">
      <View className="h-16 w-16 items-center justify-center rounded-2xl border-2 border-accent">
        <Icon name="camera" size={28} className="text-accent" />
      </View>
      <View className="items-center gap-2">
        <Text className="text-center font-h1 text-h1 text-textPrimary">
          You haven&apos;t joined any events yet
        </Text>
        <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
          Join with an invite link or create your own.
        </Text>
      </View>
      <View className="w-full gap-3">
        <Button
          label="Join with invite code"
          variant="secondary"
          disabled
          accessibilityHint="Joining by code is not available yet."
          onPress={() => undefined}
        />
        <Button label="Create an event" onPress={onCreate} />
      </View>
    </View>
  );
}
