import type { PresignedImage, ResolveInviteResponse } from '@momentlens/shared-types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Redirect, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/ui/avatar';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { eventHref } from '@/features/event-shell/tabs';
import { ROLE_LABEL } from '@/features/events/event-card';
import { formatEventDates } from '@/features/events/format';
import { EVENTS_QUERY_KEY, rememberJoinRequest } from '@/features/events/use-events';
import { useFollowInvite } from '@/features/join/follow-invite';
import { inviteQuery, isDeadInvite } from '@/features/join/invite-query';
import {
  clearPendingInvite,
  readPendingInvite,
  type PendingInvite,
} from '@/features/join/pending-invite';
import { RolePill } from '@/features/join/role-pill';
import { joinDestination } from '@/features/join/route';
import { useMyProfile } from '@/hooks/use-my-profile';
import { ApiError, joinEvent } from '@/lib/api';
import { byPlatform } from '@/lib/copy';
import { presignedSource } from '@/lib/images';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

// Join Confirmation (spec §2.3.1 step 2, §2.5.8): a read-only preview of the event the pending
// invite opens, and the one button that joins. It reads the invite the link or code left in MMKV,
// so it survives the app being killed, and asks the API again for the caller's own membership.
export default function JoinConfirmScreen() {
  const [invite] = useState(readPendingInvite);
  if (invite === null) {
    return <Redirect href="/" />;
  }
  return <JoinConfirmation invite={invite} />;
}

function JoinConfirmation({ invite }: { invite: PendingInvite }) {
  const router = useRouter();
  const navigation = useNavigation();
  const userId = useAuthStore((state) => state.userId);
  const preview = useQuery(inviteQuery(userId, invite.lookup));
  const follow = useFollowInvite();
  const [notice, setNotice] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  // Any way off this screen that is not a join, back button, swipe or Not now, is the dismissal
  // that drops the invite (D-115). Killing the app is not, so the invite is still here next launch.
  useEffect(() => navigation.addListener('beforeRemove', () => clearPendingInvite()), [navigation]);

  // Logging in may show that this account is already in the event, waiting on it, or blocked.
  const settled = preview.data ? joinDestination(preview.data.membership) !== 'confirm' : false;
  useEffect(() => {
    if (settled && preview.data) {
      follow(invite.lookup, preview.data);
    }
  }, [settled, preview.data, follow, invite.lookup]);

  // The invite died since the link or code was read: revoked, or its event deleted or archived.
  const dead = isDeadInvite(preview.error);
  useEffect(() => {
    if (dead) {
      toRootScreen('/join-error');
    }
  });

  // Join Error and Join Blocked sit at the root, outside this group, so going there replaces the
  // group. The invite is dropped first rather than left to beforeRemove, which a screen nested in
  // a replaced group is not promised. Once is enough: a render before the group goes must not
  // replace Join Error with itself.
  const left = useRef(false);
  function toRootScreen(href: '/join-error' | '/join-blocked') {
    if (left.current) {
      return;
    }
    left.current = true;
    clearPendingInvite();
    router.replace(
      href === '/join-blocked'
        ? { pathname: href, params: { name: preview.data?.event.name ?? invite.eventName } }
        : href,
    );
  }

  const join = useMutation({
    mutationFn: () => joinEvent(invite.lookup),
    onSuccess: ({ membership }) => {
      const answer = preview.data;
      clearPendingInvite();
      if (!answer) {
        return;
      }
      const { event, role } = answer;
      if (membership.status === 'active') {
        void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
        router.replace(eventHref(event.id, membership.role));
        return;
      }
      rememberJoinRequest({
        eventId: event.id,
        eventName: event.name,
        role,
        requestedAt: new Date().toISOString(),
      });
      router.replace({
        pathname: '/join/pending/[eventId]',
        params: { eventId: event.id, name: event.name },
      });
    },
    onError: (error) => {
      if (isDeadInvite(error)) {
        toRootScreen('/join-error');
        return;
      }
      if (error instanceof ApiError && error.code === 'blocked') {
        toRootScreen('/join-blocked');
        return;
      }
      if (error instanceof ApiError && error.code === 'event_full') {
        setNotice('This event is full. Contact the event organizer.');
        return;
      }
      setNotice('You could not join just now. Check your connection and try again.');
    },
  });

  function leave() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  return (
    <View className="flex-1 bg-background">
      {preview.data && !settled ? (
        <>
          <Preview answer={preview.data} />
          <SafeAreaView edges={['bottom', 'left', 'right']}>
            <View className="w-full max-w-md gap-3 self-center pb-2 pt-3 ios:px-5 android:px-6">
              {notice ? <FormMessage message={notice} /> : null}
              <Account />
              <Button
                label={byPlatform('Join Event', 'Join event')}
                busy={join.isPending}
                onPress={() => {
                  setNotice(null);
                  join.mutate();
                }}
              />
              <Button
                label={byPlatform('Not Now', 'Not now')}
                variant="quiet"
                disabled={join.isPending}
                onPress={leave}
              />
            </View>
          </SafeAreaView>
        </>
      ) : (
        <SafeAreaView style={{ flex: 1 }}>
          <View className="h-14 flex-row items-center ios:px-4 android:px-1">
            <BackButton onPress={leave} />
          </View>
          {preview.isError ? (
            <Centered>
              <Text className="text-center font-h2 text-h2 text-textPrimary">
                The invite could not be loaded
              </Text>
              <Text className="text-center font-body text-body text-textSecondary">
                Check your connection and try again.
              </Text>
              <View className="w-full gap-2">
                <Button
                  label={preview.isFetching ? 'Trying again' : byPlatform('Try Again', 'Try again')}
                  busy={preview.isFetching}
                  onPress={() => void preview.refetch()}
                />
                <Button label={byPlatform('Not Now', 'Not now')} variant="quiet" onPress={leave} />
              </View>
            </Centered>
          ) : (
            <Centered>
              <ActivityIndicator className="text-textSecondary" />
            </Centered>
          )}
        </SafeAreaView>
      )}
      {preview.data && !settled ? (
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', top: insets.top + 6, left: 0, right: 0 }}>
          <View className="flex-row ios:px-4 android:px-1">
            <BackButton onPress={leave} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Preview({ answer }: { answer: ResolveInviteResponse }) {
  const { event, role } = answer;
  const insets = useSafeAreaInsets();
  const dates = formatEventDates(new Date(event.startsAt), new Date(event.endsAt));
  return (
    <ScrollView className="flex-1" contentContainerClassName="pb-4">
      <Cover cover={event.cover} height={300 + insets.top} />
      <View className="-mt-7 gap-6 rounded-t-[28px] bg-background pt-6">
        <View className="gap-3 ios:px-5 android:px-6">
          <RolePill role={role} label={`You're joining as ${ROLE_LABEL[role]}`} />
          <Text accessibilityRole="header" className="font-h1 text-h1 text-textPrimary">
            {event.name}
          </Text>
          <View
            accessible
            accessibilityLabel={`Dates: ${dates}`}
            className="flex-row items-center gap-2.5">
            <Icon name="calendar" size={18} className="text-textSecondary" />
            <Text className="flex-1 font-body text-body text-textSecondary">{dates}</Text>
          </View>
        </View>
        {event.venueNames.length > 0 ? (
          <Section header={event.venueNames.length > 1 ? 'Venues' : 'Venue'}>
            {event.venueNames.map((name, i) => (
              <Row
                key={`${name}-${i}`}
                leading={<Glyph name={GLYPH.pin} size={20} tone="textSecondary" />}
                title={name}
              />
            ))}
          </Section>
        ) : null}
      </View>
    </ScrollView>
  );
}

// The cover the Admin picked, presigned by the lookup (arch §3), full bleed under the status bar,
// or the aperture mark until the event has one.
function Cover({ cover, height }: { cover: PresignedImage | null; height: number }) {
  return (
    <View
      style={{ height }}
      className="w-full items-center justify-center overflow-hidden bg-surfaceMuted">
      {cover ? (
        <Image
          source={presignedSource(cover)}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon name="aperture" size={56} className="text-textMuted" />
      )}
    </View>
  );
}

// Which account the join is for, since the demo hands phones around (D-115, spec §9).
function Account() {
  const profile = useMyProfile();
  if (!profile.data) {
    return null;
  }
  return (
    <View className="flex-row items-center justify-center gap-2">
      <Avatar size={28} />
      <Text className="font-caption text-caption text-textSecondary">
        Joining as <Text className="font-semibold text-textPrimary">{profile.data.fullName}</Text>
      </Text>
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <View className="w-full max-w-md flex-1 items-center justify-center gap-4 self-center px-6">
      {children}
    </View>
  );
}
