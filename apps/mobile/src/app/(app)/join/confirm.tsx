import type { PresignedImage, ResolveInviteResponse } from '@momentlens/shared-types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Redirect, useNavigation, useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/ui/app-header';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon, type IconName } from '@/components/ui/icon';
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
  // a replaced group is not promised.
  function toRootScreen(href: '/join-error' | '/join-blocked') {
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
        router.replace({ pathname: '/event/[id]', params: { id: event.id } });
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
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }}>
        <View className="px-4">
          <AppHeader left={{ icon: 'chevron-left', label: 'Back', onPress: leave }} />
        </View>

        {preview.data && !settled ? (
          <>
            <Preview answer={preview.data} />
            <View className="w-full max-w-md gap-3 self-center px-4 pb-2 pt-3">
              {notice ? <FormMessage message={notice} /> : null}
              <Account />
              <Button
                label="Join event"
                busy={join.isPending}
                onPress={() => {
                  setNotice(null);
                  join.mutate();
                }}
              />
              <Button
                label="Not now"
                variant="secondary"
                disabled={join.isPending}
                onPress={leave}
              />
            </View>
          </>
        ) : preview.isError ? (
          <Centered>
            <Text className="text-center font-h2 text-h2 text-textPrimary">
              The invite could not be loaded
            </Text>
            <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
              Check your connection and try again.
            </Text>
            <View className="w-full gap-2">
              <Button
                label={preview.isFetching ? 'Trying again' : 'Try again'}
                busy={preview.isFetching}
                onPress={() => void preview.refetch()}
              />
              <Button label="Not now" variant="secondary" onPress={leave} />
            </View>
          </Centered>
        ) : (
          <Centered>
            <ActivityIndicator className="text-accent" />
          </Centered>
        )}
      </SafeAreaView>
    </View>
  );
}

function Preview({ answer }: { answer: ResolveInviteResponse }) {
  const { event, role } = answer;
  const dates = formatEventDates(new Date(event.startsAt), new Date(event.endsAt));
  return (
    <ScrollView contentContainerClassName="px-4 pb-4 pt-2">
      <View className="w-full max-w-md gap-6 self-center">
        <Cover cover={event.cover} />
        <View className="gap-4">
          <View className="gap-3">
            <RolePill role={role} label={`You're joining as ${ROLE_LABEL[role]}`} />
            <Text accessibilityRole="header" className="font-h1 text-h1 text-textPrimary">
              {event.name}
            </Text>
          </View>
          <View className="gap-3">
            <Detail icon="calendar" label="Dates" text={dates} />
            <Detail
              icon="map-pin"
              label={event.venueNames.length > 1 ? 'Venues' : 'Venue'}
              text={event.venueNames.join(' · ')}
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

// The cover the Admin picked, presigned by the lookup (arch §3), or the aperture mark until the
// event has one.
function Cover({ cover }: { cover: PresignedImage | null }) {
  return (
    <View
      style={{ aspectRatio: 4 / 3 }}
      className="w-full items-center justify-center overflow-hidden rounded-3xl bg-surfaceMuted">
      {cover ? (
        <Image
          source={presignedSource(cover)}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon name="aperture" size={48} className="text-textMuted" />
      )}
    </View>
  );
}

function Detail({ icon, label, text }: { icon: IconName; label: string; text: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${text}`} className="flex-row gap-3">
      <View className="pt-0.5">
        <Icon name={icon} size={18} className="text-textSecondary" />
      </View>
      <Text className="flex-1 font-body text-body text-textSecondary">{text}</Text>
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
        Joining as{' '}
        <Text className="font-manrope-semibold text-textPrimary">{profile.data.fullName}</Text>
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
