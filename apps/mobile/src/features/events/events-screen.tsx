import type { EventSummary } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { ActivityIndicator, Platform, RefreshControl, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Fab } from '@/components/ui/fab';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section, SectionGap } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { LargeTitleScreen } from '@/components/ui/large-title-screen';
import { eventHref } from '@/features/event-shell/tabs';
import { CoverCard, PastEventRow, ROLE_LABEL } from '@/features/events/event-card';
import { groupByTiming } from '@/features/events/list';
import { useCreateEvent } from '@/features/events/use-create-event';
import { useEvents } from '@/features/events/use-events';
import { useTimingNow } from '@/features/events/use-timing-now';
import { usePullRefresh } from '@/hooks/use-pull-refresh';
import { byPlatform } from '@/lib/copy';
import { CREATE_IN_TAB_BAR } from '@/lib/platform';

// The FAB's 56 points and the 16 below it, which the end of the list scrolls clear of.
const FAB_CLEARANCE = 56 + 16;

// The Events tab, the Global shell's landing screen (spec §2.5.1). One list in three sections,
// Happening now, Upcoming and Past, each shown only when it holds an event, so nothing hides behind
// a tab (D-126). D-110's sort still decides the section. The caller's own join requests waiting for
// approval sit above them as rows (D-115), and Join with code is in the bar.
export function EventsScreen() {
  const router = useRouter();
  const events = useEvents();
  const pull = usePullRefresh(events.refetch);
  const createEvent = useCreateEvent();
  const now = useTimingNow(events.data?.events);
  const groups = useMemo(
    () => (events.data ? groupByTiming(events.data.events, now) : null),
    [events.data, now],
  );
  // Newest first. A request has no dates of its own to sort by.
  const requests = useMemo(
    () =>
      [...(events.data?.joinRequests ?? [])].sort((a, b) =>
        b.requestedAt.localeCompare(a.requestedAt),
      ),
    [events.data],
  );

  function joinWithCode() {
    router.push('/join-code');
  }

  function open(event: EventSummary) {
    router.push(eventHref(event.id, event.role));
  }

  // Android's FAB floats over the list, which scrolls clear of it. iOS 26 has the tab bar's button.
  const fab = !CREATE_IN_TAB_BAR;

  let body: ReactNode;
  if (events.isPending) {
    body = (
      <View className="items-center gap-3 py-24">
        <ActivityIndicator className="text-textSecondary" />
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          Loading your events
        </Text>
      </View>
    );
  } else if (events.isError && !events.data) {
    body = (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center font-h2 text-h2 text-textPrimary">
          Your events could not be loaded
        </Text>
        <Text className="text-center font-body text-body text-textSecondary">
          Check the connection and try again.
        </Text>
        <Button
          label={events.isFetching ? 'Trying again' : byPlatform('Try Again', 'Try again')}
          variant="secondary"
          size="small"
          busy={events.isFetching}
          onPress={() => void events.refetch()}
        />
      </View>
    );
  } else if (groups && events.data.events.length === 0 && requests.length === 0) {
    body = <NoEvents onJoin={joinWithCode} />;
  } else if (groups) {
    body = (
      <View className="gap-2">
        {events.isError ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message="The list could not be refreshed. It shows what was loaded before." />
          </View>
        ) : null}
        {requests.length > 0 ? (
          <Section>
            {requests.map((request) => (
              <Row
                key={request.eventId}
                leading={<Glyph name={GLYPH.clock} size={22} tone="textSecondary" />}
                title={request.eventName}
                subtitle={`Waiting for approval · ${ROLE_LABEL[request.role]}`}
                chevron
                accessibilityLabel={`${request.eventName}, waiting for approval as ${ROLE_LABEL[request.role]}`}
                accessibilityHint="Opens the request"
                onPress={() =>
                  router.push({
                    pathname: '/join/pending/[eventId]',
                    params: { eventId: request.eventId, name: request.eventName },
                  })
                }
              />
            ))}
          </Section>
        ) : null}
        {groups.active.length > 0 ? (
          <Cards title={byPlatform('Happening Now', 'Happening now')}>
            {groups.active.map((event) => (
              <CoverCard key={event.id} event={event} live now={now} onPress={() => open(event)} />
            ))}
          </Cards>
        ) : null}
        {groups.upcoming.length > 0 ? (
          <Cards title="Upcoming">
            {groups.upcoming.map((event) => (
              <CoverCard key={event.id} event={event} now={now} onPress={() => open(event)} />
            ))}
          </Cards>
        ) : null}
        {groups.past.length > 0 ? (
          <>
            <SectionTitle>Past</SectionTitle>
            <Section>
              {groups.past.map((event) => (
                <PastEventRow key={event.id} event={event} onPress={() => open(event)} />
              ))}
            </Section>
          </>
        ) : null}
        <SectionGap />
      </View>
    );
  }

  return (
    <LargeTitleScreen
      title="Events"
      actions={[
        {
          key: 'join',
          label: 'Join with code',
          text: 'Join',
          glyph: GLYPH.join,
          onPress: joinWithCode,
        },
      ]}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      bottomInset={fab ? FAB_CLEARANCE : 0}
      overlay={
        fab ? (
          <Fab
            icon="plus"
            label="Create an event"
            onPress={createEvent}
            bottom={Platform.OS === 'ios' ? 100 : 16}
          />
        ) : null
      }>
      {body}
    </LargeTitleScreen>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="pb-2.5 pt-5 font-h2 text-h2 text-textPrimary ios:px-5 android:px-4">
      {children}
    </Text>
  );
}

function Cards({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <SectionTitle>{title}</SectionTitle>
      <View className="gap-3.5 ios:px-5 android:px-4">{children}</View>
    </View>
  );
}

// No events and no requests (spec §2.4 step 4): the mark, what to do, and the code. Create is the
// tab bar's button or the FAB, which is already on screen.
function NoEvents({ onJoin }: { onJoin: () => void }) {
  return (
    <View className="items-center gap-3 px-10 pt-28">
      <View className="mb-1 h-16 w-16 items-center justify-center rounded-full bg-textPrimary/5">
        <Icon name="aperture" size={30} className="text-textSecondary" />
      </View>
      <Text className="text-center font-h2 text-h2 text-textPrimary">No events yet</Text>
      <Text className="text-center font-body text-body text-textSecondary">
        Open the invite link you were sent, or enter the code from the card. To host your own, tap
        +.
      </Text>
      <View className="pt-2">
        <Button
          label={byPlatform('Join with Code', 'Join with code')}
          icon="ticket"
          variant={Platform.OS === 'ios' ? 'secondary' : 'tonal'}
          size="small"
          onPress={onJoin}
        />
      </View>
    </View>
  );
}
