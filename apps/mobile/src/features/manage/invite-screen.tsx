import type { ManagedInvite } from '@momentlens/shared-types';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnchoredMenu, type MenuAnchor } from '@/components/ui/anchored-menu';
import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Icon } from '@/components/ui/icon';
import { useEvent } from '@/features/event-shell/use-event';
import {
  inviteLink,
  inviteProblem,
  inviteRoleName,
  replacementMessage,
  type InviteAction,
} from '@/features/manage/invite';
import { freshInvites, rotateInvite, sendInvite, useInvites } from '@/features/manage/use-invites';
import { useTokenColor } from '@/hooks/use-token-color';
import { ApiError } from '@/lib/api';
import { byPlatform } from '@/lib/copy';
import { useAuthStore } from '@/stores/auth';

const IOS = Platform.OS === 'ios';
const MORE = { ios: 'ellipsis', android: 'more_vert' } as const;

function confirmReplacement(invite: ManagedInvite): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      `Replace ${inviteRoleName(invite.role)} invite?`,
      replacementMessage(invite.role),
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Revoke & Regenerate', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

interface InviteCardProps {
  invite: ManagedInvite;
  disabled: boolean;
  inactive: boolean;
  onSend: (action: InviteAction) => void;
  onReplace: () => void;
}

// Layout follows the supplied Invite frames. Sizes and colours use the app's platform tokens.
function InviteCard({ invite, disabled, inactive, onSend, onReplace }: InviteCardProps) {
  const more = useRef<View>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const label = byPlatform(
    `${inviteRoleName(invite.role)} Link`,
    `${inviteRoleName(invite.role)} link`,
  );

  function openMenu() {
    if (disabled) return;
    if (IOS) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: label,
          options: ['Cancel', 'Revoke & Regenerate'],
          cancelButtonIndex: 0,
          destructiveButtonIndex: 1,
        },
        (index) => {
          if (index === 1) onReplace();
        },
      );
    } else {
      more.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
    }
  }

  const heading = (
    <Text
      accessibilityRole="header"
      className="font-fieldLabel text-fieldLabel ios:text-textSecondary android:text-accentText">
      {label}
    </Text>
  );
  return (
    <View className="gap-2">
      {IOS ? <View className="px-4">{heading}</View> : null}
      <View className="gap-4 rounded-[26px] bg-surface p-4">
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            {!IOS ? (
              heading
            ) : (
              <Text
                accessibilityLabel={`${inviteRoleName(invite.role)} code, ${invite.code.split('').join(' ')}`}
                className="font-mono text-title font-semibold tracking-widest text-textPrimary">
                {invite.code.slice(0, 3)} {invite.code.slice(3)}
              </Text>
            )}
          </View>
          <Pressable
            ref={more}
            accessibilityRole="button"
            accessibilityLabel={`${inviteRoleName(invite.role)} invite options`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={openMenu}
            className={`h-12 w-12 items-center justify-center rounded-full ios:bg-surfaceMuted ${disabled ? 'opacity-40' : ''}`}>
            <Glyph name={MORE} size={24} />
          </Pressable>
        </View>
        {!IOS ? (
          <Text
            accessibilityLabel={`${inviteRoleName(invite.role)} code, ${invite.code.split('').join(' ')}`}
            className="font-mono text-title tracking-widest text-textPrimary">
            {invite.code.slice(0, 3)} {invite.code.slice(3)}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          className="font-mono text-bodySecondary text-textSecondary">
          {inviteLink(invite)}
        </Text>
        {inactive ? (
          <Text className="font-fieldLabel text-fieldLabel text-textSecondary">Inactive</Text>
        ) : null}
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              label="Share"
              size="small"
              disabled={disabled || inactive}
              onPress={() => onSend('share')}
            />
          </View>
          <View className="flex-1">
            <Button
              label="Copy code"
              size="small"
              variant="secondary"
              disabled={disabled || inactive}
              onPress={() => onSend('code')}
            />
          </View>
        </View>
        <Button
          label="Copy link"
          size="small"
          variant="quiet"
          disabled={disabled || inactive}
          onPress={() => onSend('link')}
        />
        {invite.role === 'photographer' ? (
          <View className="flex-row gap-2">
            <Icon name="circle-alert" className="text-danger" size={18} />
            <Text className="flex-1 font-bodySecondary text-bodySecondary text-textSecondary">
              Anyone with this link can join as a Photographer, subject to Approval Mode. Once
              admitted, they can upload from anywhere without checking in. Send it only to your
              photographers.
            </Text>
          </View>
        ) : null}
      </View>
      <AnchoredMenu
        anchor={anchor}
        onClose={() => setAnchor(null)}
        items={[
          {
            key: 'replace',
            label: 'Revoke & Regenerate',
            destructive: true,
            disabled,
            onPress: onReplace,
          },
        ]}
      />
    </View>
  );
}

export function InviteScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const background = useTokenColor('background');
  const foreground = useTokenColor('textPrimary');
  const owner = useAuthStore((state) => state.userId);
  const event = useEvent(eventId).data?.event;
  const query = useInvites(eventId);
  const busyNow = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function begin() {
    if (busyNow.current || owner === null) return false;
    busyNow.current = true;
    setBusy(true);
    setMessage(null);
    return true;
  }
  function finish(text: string | null, error: boolean) {
    busyNow.current = false;
    if (mounted.current && useAuthStore.getState().userId === owner) {
      setBusy(false);
      setMessage(text ? { text, error } : null);
    }
  }
  async function send(invite: ManagedInvite, action: InviteAction) {
    if (!begin() || owner === null) return;
    const result = await sendInvite(eventId, invite.role, action, owner);
    finish(result.ok ? result.value : result.problem, !result.ok);
  }
  async function replace(invite: ManagedInvite) {
    if (!begin() || owner === null) return;
    if (!(await confirmReplacement(invite)) || !mounted.current) {
      finish(null, false);
      return;
    }
    const result = await rotateInvite(eventId, invite, owner);
    finish(
      result.ok ? 'New link and code ready. The old ones no longer work.' : result.problem,
      !result.ok,
    );
  }
  async function refresh() {
    if (!begin() || owner === null) return;
    try {
      await freshInvites(eventId, owner);
      finish(null, false);
    } catch (error) {
      finish(inviteProblem(error instanceof ApiError ? error : {}, 'read'), true);
    }
  }

  const inactive = event?.archivedAt !== null && event?.archivedAt !== undefined;
  const disabled = busy || query.isFetching || query.isError || !event || event.role !== 'admin';
  const ordered = query.data
    ? ['guest', 'photographer'].flatMap((role) =>
        query.data.invites.filter((invite) => invite.role === role),
      )
    : [];

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={
          IOS
            ? {
                headerShown: true,
                title: 'Invite',
                headerLargeTitleEnabled: false,
                headerTransparent: false,
                headerShadowVisible: false,
                headerTintColor: foreground,
                headerBackButtonDisplayMode: 'minimal',
                headerStyle: { backgroundColor: background },
              }
            : { headerShown: false }
        }
      />
      {!IOS ? (
        <View style={{ paddingTop: insets.top }}>
          <View className="h-16 flex-row items-center gap-1 pl-1 pr-4">
            <BarIconButton
              glyph={GLYPH.back}
              label="Back to Manage"
              onPress={() => router.back()}
            />
            <Text accessibilityRole="header" className="px-1 font-h2 text-h2 text-textPrimary">
              Invite
            </Text>
          </View>
        </View>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pb-10 pt-3">
        {inactive ? (
          <FormMessage
            tone="info"
            message="This event is archived. Invites are inactive. You can replace them, but Copy and Share are disabled."
          />
        ) : null}
        {message ? (
          <FormMessage tone={message.error ? 'error' : 'info'} message={message.text} />
        ) : null}
        {query.isError ? (
          <FormMessage
            message={inviteProblem(query.error instanceof ApiError ? query.error : {}, 'read')}
          />
        ) : null}
        {(query.isPending && !query.isError) || busy ? (
          <ActivityIndicator accessibilityLabel="Refreshing invites" color={foreground} />
        ) : null}
        {ordered.map((invite) => (
          <InviteCard
            key={invite.role}
            invite={invite}
            disabled={disabled}
            inactive={inactive}
            onSend={(action) => {
              void send(invite, action);
            }}
            onReplace={() => {
              void replace(invite);
            }}
          />
        ))}
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          Copy and Share refresh the invite first and need a connection. Sharing does not change
          Approval Mode or approve anyone.
        </Text>
        <Button
          label="Refresh invites"
          variant="quiet"
          size="small"
          disabled={busy || query.isFetching}
          onPress={() => {
            void refresh();
          }}
        />
      </ScrollView>
    </View>
  );
}
