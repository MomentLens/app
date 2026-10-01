import type { MembershipRole } from '@momentlens/shared-types';
import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/ui/app-header';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { eventHref } from '@/features/event-shell/tabs';
import { ROLE_LABEL } from '@/features/events/event-card';
import { EVENTS_QUERY_KEY, forgetJoinRequest, useEvents } from '@/features/events/use-events';
import { RolePill } from '@/features/join/role-pill';
import { cancelJoinRequest } from '@/lib/api';
import { queryClient } from '@/lib/query-client';

// How often the screen asks whether the organizer has answered, on top of every return to the
// foreground (D-115). The Approval Alerts push replaces waiting on it in Phase 6 (hb §14.6).
const POLL_MS = 30_000;

// Pending Approval (spec §2.3.1 step 3, §2.5.8): a waiting state, not a spinner, with Cancel
// Request. It reads the caller's request from GET /events, which lists their own pending rows,
// and opens Event Home once the row turns active or goes back to the Events list once it is gone.
export default function PendingApprovalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ eventId: string; name?: string }>();
  const eventId = params.eventId;
  const events = useEvents({ refetchInterval: POLL_MS });
  const request = events.data?.joinRequests.find((candidate) => candidate.eventId === eventId);
  const approvedEvent = events.data?.events.find((event) => event.id === eventId);
  const approved = approvedEvent !== undefined;
  // Only an answer fetched since this screen opened can say the request is gone. The list cached
  // before a join does not have it yet.
  const gone =
    events.isFetchedAfterMount &&
    !events.isFetching &&
    !events.isError &&
    request === undefined &&
    !approved;
  const eventName =
    request?.eventName ??
    (typeof params.name === 'string' && params.name !== '' ? params.name : 'this event');
  const [notice, setNotice] = useState<string | null>(null);
  // Set once the screen starts leaving, so a refetch landing mid-transition cannot navigate twice.
  const leaving = useRef(false);

  function toEvents() {
    if (leaving.current) {
      return;
    }
    leaving.current = true;
    router.dismissTo('/');
  }

  function toEvent(role: MembershipRole) {
    if (leaving.current) {
      return;
    }
    leaving.current = true;
    router.replace(eventHref(eventId, role));
  }

  useEffect(() => {
    if (approvedEvent) {
      toEvent(approvedEvent.role);
    } else if (gone) {
      toEvents();
    }
  });

  const cancel = useMutation({
    mutationFn: () => cancelJoinRequest(eventId),
    onSuccess: ({ membership }) => {
      // An approve that got there first leaves the member active, and they go in (arch:membership).
      if (membership?.status === 'active') {
        void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY });
        toEvent(membership.role);
        return;
      }
      forgetJoinRequest(eventId);
      toEvents();
    },
    onError: () => {
      setNotice('The request could not be cancelled. Check your connection and try again.');
    },
  });

  function confirmCancel() {
    Alert.alert(
      'Cancel your request?',
      `To ask to join ${eventName} again, you will need the invite link or code.`,
      [
        { text: 'Keep waiting', style: 'cancel' },
        {
          text: 'Cancel request',
          style: 'destructive',
          onPress: () => {
            setNotice(null);
            cancel.mutate();
          },
        },
      ],
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }}>
        <View className="px-4">
          <AppHeader left={{ icon: 'chevron-left', label: 'Events', onPress: toEvents }} />
        </View>

        <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-8">
          <View className="w-full max-w-md items-center gap-6 self-center">
            <View className="h-20 w-20 items-center justify-center rounded-full bg-accentTint">
              <Icon name="clock" size={32} className="text-accent" />
            </View>
            <View className="items-center gap-3">
              <Text
                accessibilityRole="header"
                className="text-center font-h1 text-h1 text-textPrimary">
                Waiting for approval
              </Text>
              <Text className="text-center font-body text-body text-textSecondary">
                Waiting for the organizer to approve your request to join{' '}
                <Text className="font-manrope-semibold text-textPrimary">{eventName}</Text>.
              </Text>
            </View>
            {request ? (
              <View className="self-center">
                <RolePill role={request.role} label={`Requested as ${ROLE_LABEL[request.role]}`} />
              </View>
            ) : null}
            <Text className="text-center font-caption text-caption text-textSecondary">
              The event opens here once they approve. You can leave this screen: the request stays
              on your Events list.
            </Text>
          </View>
        </ScrollView>

        <View className="w-full max-w-md gap-2 self-center px-4 pb-2 pt-3">
          {notice ? <FormMessage message={notice} /> : null}
          <Button label="Back to events" variant="secondary" onPress={toEvents} />
          <Button
            label="Cancel request"
            variant="destructive"
            busy={cancel.isPending}
            onPress={confirmCancel}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}
