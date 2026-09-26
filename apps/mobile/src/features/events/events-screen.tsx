import type { EventTiming } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/ui/app-header';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { BottomTabInset } from '@/constants/theme';
import { startDraft } from '@/features/events/draft';
import { EventCard } from '@/features/events/event-card';
import { groupByTiming } from '@/features/events/list';
import { showEventsTab, useEventsTab } from '@/features/events/tab-store';
import { TimingTabs } from '@/features/events/timing-tabs';
import { useEvents } from '@/features/events/use-events';
import { useTimingNow } from '@/features/events/use-timing-now';
import { useAuthStore } from '@/stores/auth';

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
  const userId = useAuthStore((state) => state.userId);
  const tab = useEventsTab((state) => state.tab);
  const events = useEvents();
  const now = useTimingNow(events.data?.events);
  const groups = useMemo(
    () => (events.data ? groupByTiming(events.data.events, now) : null),
    [events.data, now],
  );

  function createEvent() {
    if (userId === null) return;
    startDraft(userId);
    router.push('/events/new');
  }

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
                <Avatar size={32} />
              </Pressable>
            }
          />
          <TimingTabs value={tab} onChange={showEventsTab} />
        </View>

        <ScrollView
          contentContainerClassName="flex-grow gap-3 px-4 pt-1"
          contentContainerStyle={{ paddingBottom: insets.bottom + BottomTabInset + 96 }}
          refreshControl={
            <RefreshControl
              refreshing={events.isRefetching}
              onRefresh={() => void events.refetch()}
            />
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

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create an event"
          onPress={createEvent}
          style={{ bottom: insets.bottom + BottomTabInset + 16 }}
          className="absolute right-5 h-14 w-14 items-center justify-center rounded-full bg-accent shadow-md active:bg-accentPressed">
          <Icon name="plus" size={24} className="text-textPrimary dark:text-background" />
        </Pressable>
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
