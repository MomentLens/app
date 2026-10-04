import type { InviteRole } from '@momentlens/shared-types';
import { onlineManager } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';

import { AnchoredMenu, type MenuAnchor } from '@/components/ui/anchored-menu';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Row, Section } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { eventHref } from '@/features/event-shell/tabs';
import { useEvent } from '@/features/event-shell/use-event';
import {
  attendeeActionsReady,
  attendeeInitials,
  attendeeSheetExit,
  findAttendee,
  loadedAttendee,
  saveAttendeeAction,
  useAttendees,
  type AttendeeAction,
  type AttendeeFilters,
} from '@/features/manage/use-attendees';
import { useSheetBottomPadding } from '@/features/schedule/sheet-inset';

const IOS = Platform.OS === 'ios';

// S-29 supplies event-scoped avatar privacy. This draws only initials, including for the Admin.
export function AttendeeInitials({ fullName, size = 48 }: { fullName: string; size?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className="items-center justify-center bg-accentTint">
      <Text
        className={`${size >= 80 ? 'font-h1 text-h1' : 'font-fieldLabel text-fieldLabel'} text-accentText`}>
        {attendeeInitials(fullName)}
      </Text>
    </View>
  );
}

export function AttendeeSheet({
  eventId,
  userId,
  filters,
}: {
  eventId: string;
  userId: string;
  filters: AttendeeFilters;
}) {
  const router = useRouter();
  const bottom = useSheetBottomPadding();
  // A cold link has no loaded target. It returns to the list instead of reconstructing a sheet
  // from route params or fetching a different person's profile (D-143).
  const [hadTarget] = useState(() => loadedAttendee(eventId, filters, userId) !== undefined);
  const query = useAttendees(eventId, filters, hadTarget);
  const event = useEvent(eventId);
  const target = findAttendee(query.data, userId);
  // attendeeActionsReady reads the connection when it runs. Subscribing redraws the sheet when it
  // changes, so the rows disable as soon as the phone goes offline.
  const online = useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline());
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const mounted = useRef(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const roleField = useRef<View>(null);
  const eventRole = event.data?.event.role;
  const ready = online && !busy && attendeeActionsReady(eventId, filters);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const returnToList = useCallback(() => {
    router.dismissTo({ pathname: '/event/[id]/manage/attendees', params: { id: eventId } });
  }, [router, eventId]);

  const found = hadTarget && target !== undefined;
  useEffect(() => {
    const exit = attendeeSheetExit(found, eventRole, event.error);
    if (exit === 'list') returnToList();
    else if (exit === 'event') router.dismissTo(eventHref(eventId, eventRole ?? 'admin'));
  }, [found, eventRole, event.error, returnToList, router, eventId]);

  async function act(action: AttendeeAction) {
    if (!mounted.current || busyNow.current || !target) return;
    busyNow.current = true;
    setBusy(true);
    setProblem(null);
    const result = await saveAttendeeAction(eventId, filters, target, action);
    // The cache refresh finishes even when the sheet closes. It never navigates a person who
    // already left the sheet back into the event.
    if (!mounted.current) return;
    busyNow.current = false;
    setBusy(false);
    if (!result.ok) {
      if (result.returnToList) returnToList();
      else setProblem(result.problem);
    } else if (action.kind !== 'role') returnToList();
  }

  function confirm(kind: 'remove' | 'block') {
    if (!target || !ready) return;
    // Capture the loaded target inside act's current render. A confirm left open while another
    // phone changes it still sends that version, which the local and API guards reject.
    const name = target.fullName;
    Alert.alert(
      `${kind === 'remove' ? 'Remove' : 'Block'} ${name}?`,
      kind === 'remove'
        ? 'Their photos stay in the album. They can join again through a live invite.'
        : 'Their photos stay in the album. They cannot join again through an invite.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: kind === 'remove' ? 'Remove' : 'Block',
          style: 'destructive',
          onPress: () => void act({ kind }),
        },
      ],
    );
  }

  function chooseRole(role: InviteRole) {
    if (!target || role === target.role) return;
    Alert.alert(
      `Change ${target.fullName}'s role?`,
      `They will become a ${role === 'guest' ? 'Guest' : 'Photographer'}. Their photos stay in the album.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change role', onPress: () => void act({ kind: 'role', role }) },
      ],
    );
  }

  function roleMenu() {
    if (!ready) return;
    if (IOS) {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Role', options: ['Cancel', 'Guest', 'Photographer'], cancelButtonIndex: 0 },
        (index) => {
          if (index === 1) chooseRole('guest');
          else if (index === 2) chooseRole('photographer');
        },
      );
    } else {
      roleField.current?.measureInWindow((x, y, width, height) =>
        setAnchor({ x, y, width, height }),
      );
    }
  }

  if (!target)
    return (
      <View collapsable={false} className="bg-background py-10">
        <ActivityIndicator className="text-textSecondary" />
      </View>
    );
  const roleLabel =
    target.role === 'admin' ? 'Admin' : target.role === 'guest' ? 'Guest' : 'Photographer';
  const joined = new Date(target.requestedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <View collapsable={false} className="bg-background">
      <SheetHandle />
      <SheetToolbar onClose={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: bottom, gap: 24 }}>
        <View className="ios:items-center ios:gap-3 ios:px-5 android:flex-row android:items-center android:gap-4 android:px-6">
          <AttendeeInitials fullName={target.fullName} size={IOS ? 80 : 64} />
          <View className="gap-1 ios:items-center android:flex-1">
            <Text
              accessibilityRole="header"
              className="font-display text-display text-textPrimary ios:text-center">
              {target.fullName}
            </Text>
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary ios:text-center">
              {roleLabel} · Joined {joined}
            </Text>
          </View>
        </View>
        {problem || query.isError ? (
          <View className="px-5">
            <FormMessage
              message={
                problem ?? 'Attendees could not be refreshed. Refresh before another action.'
              }
            />
          </View>
        ) : null}
        {target.role === 'admin' ? (
          <Text className="px-6 font-body text-body text-textSecondary">
            The creator remains the Admin. Their role and access cannot be changed here.
          </Text>
        ) : (
          <>
            <View ref={roleField} collapsable={false}>
              <Section footer="For someone who joined through the wrong link.">
                <Row
                  title="Role"
                  value={roleLabel}
                  onPress={roleMenu}
                  disabled={!ready}
                  trailing={<Icon name="chevron-down" className="text-textMuted" size={16} />}
                />
              </Section>
            </View>
            <Section footer="Someone you remove can rejoin with a live invite. Someone you block cannot. Their photos stay in the album.">
              <Row
                title="Remove from event"
                destructive
                leading={<Icon name="user" className="text-danger" />}
                onPress={() => confirm('remove')}
                disabled={!ready}
              />
              <Row
                title="Block"
                destructive
                leading={<Icon name="ban" className="text-danger" />}
                onPress={() => confirm('block')}
                disabled={!ready}
              />
            </Section>
            {busy ? (
              <ActivityIndicator
                accessibilityLabel="Updating attendee"
                className="text-textSecondary"
              />
            ) : !ready ? (
              <View className="gap-2 px-5">
                <Text className="font-caption text-caption text-textSecondary">
                  Connect and refresh before changing this attendee.
                </Text>
                <Button
                  label="Refresh attendees"
                  variant="secondary"
                  busy={query.isFetching}
                  onPress={() => void query.refetch()}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      <AnchoredMenu
        anchor={anchor}
        onClose={() => setAnchor(null)}
        matchAnchorWidth
        items={[
          { key: 'guest', label: 'Guest', disabled: !ready, onPress: () => chooseRole('guest') },
          {
            key: 'photographer',
            label: 'Photographer',
            disabled: !ready,
            onPress: () => chooseRole('photographer'),
          },
        ]}
      />
    </View>
  );
}
