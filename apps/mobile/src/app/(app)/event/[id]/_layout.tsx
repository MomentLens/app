import type { MembershipRole } from '@momentlens/shared-types';
import { Redirect, useLocalSearchParams, useRouter, useSegments } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import type { ComponentProps, ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTabBarColors } from '@/components/app-tabs';
import { EventHeader } from '@/features/event-shell/event-header';
import { LoadFailed, Loading, NoAccess } from '@/features/event-shell/no-access';
import { redirectFor, tabHref, tabsFor, type EventTab } from '@/features/event-shell/tabs';
import { lostAccess, useEvent, type LostAccess } from '@/features/event-shell/use-event';
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

// The Event shell (spec §2.5.1, hb §16.5): the persistent header above the role's own tab bar. The
// role comes from GET /events/{eventId} through useEvent, never from the Events list (D-118).
export default function EventShellLayout() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  // [(app), event, [id], tab]: the tab is missing until the tabs have mounted on their first one.
  const tab = (useSegments() as string[])[3];
  const event = useEvent(id);
  const lost = lostAccess(event.error);

  // Back to the Events tab from whichever tab is open. router.back() inside the tabs would step
  // back through them first on Android.
  function toEvents() {
    router.dismissTo('/');
  }

  let body: ReactNode;
  if (lost !== null) {
    body = <AccessLost eventId={id} reason={lost} onBack={toEvents} />;
  } else if (event.data) {
    // A link to a tab this role lacks, or a role change while one was open, lands on the role's
    // first tab. It has to happen before the tabs render: native tabs refuse a focused route they
    // were not given.
    const redirect = redirectFor(event.data.event.role, tab);
    body =
      redirect !== null ? (
        <Redirect href={tabHref(id, redirect)} />
      ) : (
        <RoleTabs role={event.data.event.role} />
      );
  } else if (event.isError) {
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

  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView edges={['top', 'left', 'right']}>
        <EventHeader name={lost === null ? event.data?.event.name : undefined} onBack={toEvents} />
      </SafeAreaView>
      {body}
    </View>
  );
}

// The role's tab bar. Native tabs cannot add or remove a tab once mounted, so it is keyed on the
// role and a role change mounts a new one (D-118). The first tab is the landing tab, and the tabs
// open on it. Android labels every item, as Material 3's navigation bar does and as the Global
// shell's two tabs already are; left to itself it drops the unselected labels past three items.
function RoleTabs({ role }: { role: MembershipRole }) {
  const colors = useTabBarColors();
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
// caller's own (D-118), so a not_member waits for a fresh copy of it. Mounting the list refetches
// it, which also takes the event off the Events tab.
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

  if (reason === 'not_member' && !events.isFetchedAfterMount) {
    return (
      <Body>
        <Loading />
      </Body>
    );
  }
  if (reason === 'not_member' && request !== undefined) {
    return (
      <Redirect
        href={{ pathname: '/join/pending/[eventId]', params: { eventId, name: request.eventName } }}
      />
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
