import type { MembershipRole } from '@momentlens/shared-types';
import { Redirect, useIsFocused, useLocalSearchParams, useRouter, useSegments } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import type { ComponentProps, ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTabBarColors } from '@/components/app-tabs';
import { EventHeader } from '@/features/event-shell/event-header';
import { EventIdContext } from '@/features/event-shell/event-id';
import { LoadFailed, Loading, NoAccess } from '@/features/event-shell/no-access';
import { lostBody, shellBody } from '@/features/event-shell/shell-state';
import { redirectFor, tabHref, tabsFor, type EventTab } from '@/features/event-shell/tabs';
import { lostAccess, useEvent, type LostAccess } from '@/features/event-shell/use-event';
import { useMediaRealtime } from '@/features/event-shell/use-media-realtime';
import { useEvents } from '@/features/events/use-events';

type TabIcon = ComponentProps<typeof NativeTabs.Trigger.Icon>;

const TAB_BAR: Record<EventTab, { label: string; icon: TabIcon }> = {
  home: {
    label: 'Home',
    icon: { sf: { default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }, md: 'grid_view' },
  },
  media: {
    label: 'My Media',
    icon: { sf: { default: 'photo.stack', selected: 'photo.stack.fill' }, md: 'photo_library' },
  },
  schedule: { label: 'Schedule', icon: { sf: 'calendar', md: 'calendar_month' } },
  manage: {
    label: 'Manage',
    icon: { sf: { default: 'gearshape', selected: 'gearshape.fill' }, md: 'settings' },
  },
};

// The Event shell (spec §2.5.1, hb §16.5): the role's own tab bar, each tab under the Event header
// (features/event-shell/event-tab-screen.tsx). The role comes from GET /events/{eventId} through
// useEvent, never from the Events list (D-118).
export default function EventShellLayout() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  // [(app), event, [id], tab]: the tab is missing until the tabs have mounted on their first one.
  // The segments are the focused route's, so while a sheet in the (app) Stack covers the shell they
  // name the sheet, and for a render after it closes focus is back before they are. Read without
  // both checks, they redirected: the tabs under the sheet unmounted and reopened on the first tab.
  const segments = useSegments() as string[];
  const focused = useIsFocused();
  const tab = focused && segments[1] === 'event' ? segments[3] : undefined;
  const event = useEvent(id);
  const lost = lostAccess(event.error);
  const view = shellBody({
    lost,
    hasData: event.data !== undefined,
    isError: event.isError,
    isFetching: event.isFetching,
  });

  // Back to the Events tab from whichever tab is open. router.back() inside the tabs would step
  // back through them first on Android.
  function toEvents() {
    router.dismissTo('/');
  }

  let body: ReactNode;
  if (view === 'lost' && lost !== null) {
    body = <AccessLost eventId={id} reason={lost} onBack={toEvents} />;
  } else if (view === 'tabs' && event.data) {
    // A link to a tab this role lacks, or a role change while one was open, lands on the role's
    // first tab. It has to happen before the tabs render: native tabs refuse a focused route they
    // were not given.
    const redirect = redirectFor(event.data.event.role, tab);
    body =
      redirect !== null ? (
        <Redirect href={tabHref(id, redirect)} />
      ) : (
        <EventIdContext.Provider value={id}>
          <RoleTabs role={event.data.event.role} eventId={id} />
        </EventIdContext.Provider>
      );
  } else if (view === 'failed') {
    body = (
      <Body>
        <LoadFailed retrying={event.isFetching} onRetry={() => void event.refetch()} />
      </Body>
    );
  } else {
    body = (
      <Body>
        <Loading />
      </Body>
    );
  }

  // The tabs draw the Event header themselves, so it collapses with each tab's content (D-125).
  // Only the states without tabs need the shell's own bar and its way back.
  if (view === 'tabs' && event.data) {
    return <View className="flex-1 bg-background">{body}</View>;
  }
  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView edges={['top', 'left', 'right']}>
        <EventHeader onBack={toEvents} />
      </SafeAreaView>
      {body}
    </View>
  );
}

// The role's tab bar. Native tabs cannot add or remove a tab once mounted, so it is keyed on the
// role and a role change mounts a new one (D-118). The first tab is the landing tab, and the tabs
// open on it. Android labels every item, as Material 3's navigation bar does and as the Global
// shell's two tabs already are; left to itself it drops the unselected labels past three items.
function RoleTabs({ role, eventId }: { role: MembershipRole; eventId: string }) {
  const colors = useTabBarColors();
  useMediaRealtime(eventId);
  return (
    <NativeTabs key={role} {...colors} labelVisibilityMode="labeled">
      {tabsFor(role).map((name) => (
        <NativeTabs.Trigger key={name} name={name}>
          <NativeTabs.Trigger.Label>{TAB_BAR[name].label}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon {...TAB_BAR[name].icon} />
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}

// The API said no. A pending join request is told apart by the Events list, which holds the
// caller's own (D-118), so a not_member waits for a fresh copy of it (lostBody). Mounting the list
// refetches it, which also takes the event off the Events tab.
function AccessLost({
  eventId,
  reason,
  onBack,
}: {
  eventId: string;
  reason: LostAccess;
  onBack: () => void;
}) {
  const events = useEvents();
  const request = events.data?.joinRequests.find((candidate) => candidate.eventId === eventId);
  const view = lostBody(reason, {
    fetchedAfterMount: events.isFetchedAfterMount,
    isSuccess: events.isSuccess,
    isError: events.isError,
    hasRequest: request !== undefined,
  });

  if (view === 'pending' && request !== undefined) {
    return (
      <Redirect
        href={{ pathname: '/join/pending/[eventId]', params: { eventId, name: request.eventName } }}
      />
    );
  }
  if (view === 'failed') {
    return (
      <Body>
        <LoadFailed retrying={events.isFetching} onRetry={() => void events.refetch()} />
      </Body>
    );
  }
  if (view === 'loading') {
    return (
      <Body>
        <Loading />
      </Body>
    );
  }
  return (
    <Body>
      <NoAccess reason={reason} onBack={onBack} />
    </Body>
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['bottom', 'left', 'right']}>
      {children}
    </SafeAreaView>
  );
}
