import {
  MAX_JOIN_REQUEST_BATCH,
  type PendingRequest,
  type PendingRequestTarget,
} from '@momentlens/shared-types';
import { FlashList } from '@shopify/flash-list';
import { onlineManager } from '@tanstack/react-query';
import { Stack, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  ActionSheetIOS,
  Alert,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnchoredMenu, type MenuAnchor } from '@/components/ui/anchored-menu';
import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Icon } from '@/components/ui/icon';
import { eventHref } from '@/features/event-shell/tabs';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { AttendeeInitials } from '@/features/manage/attendee-sheet';
import {
  joinRequestActionsReady,
  pendingRequests,
  requestAge,
  requestTarget,
  retainRequestSelection,
  saveJoinRequestAction,
  selectLoadedRequests,
  useJoinRequests,
  type JoinRequestAction,
  type RequestConfirmation,
} from '@/features/manage/use-join-requests';
import { useTokenColor } from '@/hooks/use-token-color';
import { byPlatform } from '@/lib/copy';

const IOS = Platform.OS === 'ios';

function RequestRow({
  person,
  first,
  last,
  selecting,
  selected,
  disabled,
  now,
  onToggle,
  onAct,
  onSelect,
}: {
  person: PendingRequest;
  first: boolean;
  last: boolean;
  selecting: boolean;
  selected: boolean;
  disabled: boolean;
  now: number;
  onToggle: () => void;
  onAct: (action: JoinRequestAction) => void;
  onSelect: () => void;
}) {
  const row = useRef<View>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const border = useTokenColor('border');
  const ripple = useTokenColor('textPrimary', 0.12);
  const shape = {
    borderTopLeftRadius: first ? (IOS ? 26 : 20) : IOS ? 0 : 4,
    borderTopRightRadius: first ? (IOS ? 26 : 20) : IOS ? 0 : 4,
    borderBottomLeftRadius: last ? (IOS ? 26 : 20) : IOS ? 0 : 4,
    borderBottomRightRadius: last ? (IOS ? 26 : 20) : IOS ? 0 : 4,
  };
  const role = person.role === 'photographer' ? 'Photographer' : 'Guest';
  const label = `${person.fullName}, ${role}, ${requestAge(person.requestedAt, now)}`;

  function menu() {
    if (selecting) {
      onToggle();
      return;
    }
    if (IOS) {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', 'Select', 'Block'], cancelButtonIndex: 0, destructiveButtonIndex: 2 },
        (index) => {
          if (index === 1) onSelect();
          if (index === 2) onAct('block');
        },
      );
    } else
      row.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
  }

  const body = (
    <View ref={row} collapsable={false}>
      <Pressable
        accessibilityRole={selecting ? 'checkbox' : 'button'}
        accessibilityLabel={label}
        accessibilityHint={selecting ? 'Changes the selection.' : 'Long press for Select or Block.'}
        accessibilityState={{ checked: selecting ? selected : undefined, disabled }}
        accessibilityActions={
          selecting
            ? []
            : [
                { name: 'approve', label: 'Approve request' },
                { name: 'reject', label: 'Reject request' },
                { name: 'select', label: 'Select request' },
                { name: 'block', label: 'Block requester' },
              ]
        }
        onAccessibilityAction={({ nativeEvent }) => {
          if (disabled) return;
          if (nativeEvent.actionName === 'approve') onAct('approve');
          if (nativeEvent.actionName === 'reject') onAct('reject');
          if (nativeEvent.actionName === 'select') onSelect();
          if (nativeEvent.actionName === 'block') onAct('block');
        }}
        onPress={selecting ? onToggle : menu}
        onLongPress={menu}
        disabled={disabled}
        android_ripple={{ color: ripple }}
        style={shape}
        className="min-h-20 flex-row items-center gap-3 overflow-hidden bg-surface px-4 py-4 android:gap-4 ios:active:bg-surfaceMuted">
        {IOS && !first ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: selecting ? 108 : 80,
              right: 0,
              height: StyleSheet.hairlineWidth,
              backgroundColor: border,
            }}
          />
        ) : null}
        {selecting ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className={`h-6 w-6 items-center justify-center border-2 ios:rounded-full android:rounded-sm ${selected ? 'border-accent bg-accent' : 'border-borderStrong'}`}>
            {selected ? <Icon name="check" size={18} className="text-background" /> : null}
          </View>
        ) : null}
        <AttendeeInitials fullName={person.fullName} size={40} />
        <View className="flex-1 gap-1">
          <Text className="font-body text-body text-textPrimary">{person.fullName}</Text>
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
            <Text className={person.role === 'photographer' ? 'text-accentText' : ''}>{role}</Text>
            {` · ${requestAge(person.requestedAt, now)}`}
          </Text>
        </View>
        {!selecting ? (
          <View className="flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reject ${person.fullName}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onAct('reject')}
              className={`ios:h-11 ios:w-11 android:h-12 android:w-12 items-center justify-center rounded-full ${IOS ? 'bg-surfaceMuted' : 'border border-borderStrong'} ${disabled ? 'opacity-40' : ''}`}>
              <Icon name="x" size={IOS ? 20 : 24} className="text-textSecondary" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Approve ${person.fullName}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onAct('approve')}
              className={`ios:h-11 ios:w-11 android:h-12 android:w-12 items-center justify-center rounded-full ios:bg-accent android:bg-accentTint ${disabled ? 'opacity-40' : ''}`}>
              <Icon
                name="check"
                size={IOS ? 20 : 24}
                className="ios:text-background android:text-accentText"
              />
            </Pressable>
          </View>
        ) : null}
      </Pressable>
      <AnchoredMenu
        anchor={anchor}
        onClose={() => setAnchor(null)}
        items={[
          { key: 'select', label: 'Select', disabled, onPress: onSelect },
          {
            key: 'block',
            label: 'Block',
            disabled,
            destructive: true,
            onPress: () => onAct('block'),
          },
        ]}
      />
    </View>
  );
  return (
    <View className="ios:mx-5 android:mx-4 android:pb-0.5" style={{ ...shape, overflow: 'hidden' }}>
      {IOS && !selecting ? (
        <ReanimatedSwipeable
          key={`${person.userId}/${person.accessVersion}`}
          enabled={!disabled}
          friction={2}
          rightThreshold={40}
          overshootRight={false}
          renderRightActions={(_progress, _translation, swipeable) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Block ${person.fullName}`}
              disabled={disabled}
              onPress={() => {
                swipeable.close();
                onAct('block');
              }}
              className="w-24 items-center justify-center bg-danger">
              <Text className="font-buttonLabel text-buttonLabel text-onPhoto">Block</Text>
            </Pressable>
          )}>
          {body}
        </ReanimatedSwipeable>
      ) : (
        body
      )}
    </View>
  );
}

export function ApprovalsScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const background = useTokenColor('background');
  const foreground = useTokenColor('textPrimary');
  const event = useEvent(eventId);
  const online = useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline());
  const query = useJoinRequests(eventId, focused);
  const people = useMemo(() => pendingRequests(query.data), [query.data]);
  const [selection, setSelection] = useState<PendingRequestTarget[]>([]);
  const selected = useMemo(() => retainRequestSelection(selection, people), [selection, people]);
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);
  const [pulling, setPulling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [listHeight, setListHeight] = useState(0);
  const active = useRef(focused);
  const mounted = useRef(true);
  const ready = online && !busy && focused && joinRequestActionsReady(eventId);
  const count = selected.length;

  useEffect(() => {
    active.current = focused;
  }, [focused]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current = false;
    };
  }, []);
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      void refetch();
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 30_000);
      return () => clearInterval(timer);
    }, [refetch]),
  );
  useFocusEffect(
    useCallback(() => {
      if (IOS || !selecting) return undefined;
      const listener = BackHandler.addEventListener('hardwareBackPress', () => {
        setSelecting(false);
        setSelection([]);
        return true;
      });
      return () => listener.remove();
    }, [selecting]),
  );

  useEffect(() => {
    const role = event.data?.event.role;
    if ((role !== undefined && role !== 'admin') || lostAccess(event.error))
      router.dismissTo(eventHref(eventId, role ?? 'admin'));
  }, [event.data?.event.role, event.error, eventId, router]);

  function endSelection() {
    setSelecting(false);
    setSelection([]);
  }
  function toggle(person: PendingRequest) {
    const exists = selected.some((target) => target.userId === person.userId);
    if (!exists && count === MAX_JOIN_REQUEST_BATCH) {
      setProblem('Choose up to 50 requests at a time.');
      return;
    }
    setSelection(
      exists
        ? selected.filter((target) => target.userId !== person.userId)
        : [...selected, requestTarget(person)],
    );
  }
  function confirm(question: RequestConfirmation): Promise<boolean> {
    return new Promise((resolve) =>
      Alert.alert(
        question.title,
        question.message,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          {
            text: question.label,
            style: question.destructive ? 'destructive' : 'default',
            onPress: () => resolve(mounted.current && active.current),
          },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
  }
  async function act(targets: PendingRequestTarget[], action: JoinRequestAction) {
    if (busyNow.current || !ready) return;
    busyNow.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await saveJoinRequestAction(eventId, targets, action, confirm);
      if (!mounted.current) return;
      if (result.ok) endSelection();
      else if (!result.cancelled) setProblem(result.problem ?? 'Refresh before trying again.');
    } finally {
      busyNow.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const selectAll = () => {
    setSelecting(true);
    setSelection(selectLoadedRequests(people));
  };
  const allLoaded = Math.min(people.length, MAX_JOIN_REQUEST_BATCH);
  const title = selecting
    ? byPlatform(`${count} Selected`, `${count} selected`)
    : byPlatform('Pending Approvals', 'Pending approvals');

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={
          IOS
            ? {
                headerShown: true,
                title,
                headerLargeTitleEnabled: false,
                headerTransparent: false,
                headerShadowVisible: false,
                headerTintColor: foreground,
                headerStyle: { backgroundColor: background },
                headerBackVisible: !selecting,
                headerBackButtonDisplayMode: 'minimal',
                headerLeft: selecting
                  ? () => (
                      <GlassButton
                        label="Select all loaded requests"
                        wide
                        disabled={!ready}
                        onPress={selectAll}>
                        <Text className="font-body text-body text-textPrimary">Select All</Text>
                      </GlassButton>
                    )
                  : undefined,
                headerRight:
                  people.length > 0 || selecting
                    ? () => (
                        <GlassButton
                          label={selecting ? 'Done selecting' : 'Select requests'}
                          wide
                          disabled={busy}
                          onPress={selecting ? endSelection : () => setSelecting(true)}>
                          <Text className="font-body text-body text-textPrimary">
                            {selecting ? 'Done' : 'Select'}
                          </Text>
                        </GlassButton>
                      )
                    : undefined,
              }
            : { headerShown: false }
        }
      />
      {!IOS ? (
        <View style={{ paddingTop: insets.top }} className={selecting ? 'bg-surfaceContainer' : ''}>
          <View className={`min-h-16 flex-row items-center pl-1 ${selecting ? 'pr-4' : 'pr-2'}`}>
            <BarIconButton
              glyph={selecting ? GLYPH.close : GLYPH.back}
              label={selecting ? 'Cancel selection' : 'Back to Manage'}
              disabled={busy}
              onPress={selecting ? endSelection : () => router.back()}
            />
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              className="flex-1 px-2 font-h2 text-h2 text-textPrimary">
              {title}
            </Text>
            {selecting ? (
              // Labels, not icons. The close icon on the left already cancels the selection, and
              // Reject sends at once with no confirm.
              <View className="flex-row items-center gap-2">
                <Button
                  label="Reject"
                  variant="quiet"
                  size="small"
                  disabled={!ready || count === 0}
                  onPress={() => void act(selected, 'reject')}
                />
                <Button
                  label={`Approve ${count}`}
                  size="small"
                  disabled={!ready || count === 0}
                  onPress={() => void act(selected, 'approve')}
                />
              </View>
            ) : people.length > 0 ? (
              <Text
                accessibilityRole="button"
                onPress={() => setSelecting(true)}
                className="min-h-12 p-3 font-buttonLabel text-buttonLabel text-accentText">
                Select
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {problem || (!online && people.length > 0) || (query.isError && people.length > 0) ? (
        <View className="px-5 py-2">
          <FormMessage
            message={
              problem ??
              (!online
                ? 'Connect to the internet to manage requests.'
                : 'Requests could not be refreshed. Refresh before another action.')
            }
          />
        </View>
      ) : null}
      {busy ? (
        <View
          accessibilityLiveRegion="polite"
          className="flex-row items-center justify-center gap-2 py-2">
          <ActivityIndicator className="text-textSecondary" />
          <Text className="font-caption text-caption text-textSecondary">Updating requests</Text>
        </View>
      ) : null}
      <View className="flex-1" onLayout={(event) => setListHeight(event.nativeEvent.layout.height)}>
        <FlashList
          data={people}
          keyExtractor={(person) => person.userId}
          extraData={{ selected, selecting, ready, now }}
          maintainVisibleContentPosition={{ disabled: true }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingTop: 12, paddingBottom: IOS && selecting ? 112 : 24 }}
          refreshing={pulling}
          onRefresh={() => {
            setPulling(true);
            void refetch().finally(() => setPulling(false));
          }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetching && !query.isError && !busy)
              void query.fetchNextPage();
          }}
          ListHeaderComponent={
            people.length > 0 ? (
              <View className="flex-row items-center justify-between px-9 pb-3">
                <Text className="font-fieldLabel text-fieldLabel ios:text-textSecondary android:text-accentText">
                  {people.length}
                  {query.hasNextPage ? '+' : ''}{' '}
                  {people.length === 1 && !query.hasNextPage ? 'request' : 'requests'}
                </Text>
                {/* Approve All means the selection (D-144), so this selects and the bar approves. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${allLoaded} loaded requests`}
                  disabled={!ready}
                  onPress={selectAll}
                  className={`ios:min-h-11 android:min-h-12 justify-center ${!ready ? 'opacity-40' : ''}`}>
                  <Text className="font-body text-body text-accentText">
                    {query.hasNextPage || people.length > MAX_JOIN_REQUEST_BATCH
                      ? `Select ${allLoaded}`
                      : 'Select all'}
                  </Text>
                </Pressable>
              </View>
            ) : null
          }
          renderItem={({ item, index }) => (
            <RequestRow
              key={`${item.userId}/${item.accessVersion}/${selecting}`}
              person={item}
              first={index === 0}
              last={index === people.length - 1}
              selecting={selecting}
              selected={selected.some((target) => target.userId === item.userId)}
              disabled={!ready}
              now={now}
              onToggle={() => toggle(item)}
              onSelect={() => {
                setSelecting(true);
                setSelection([requestTarget(item)]);
              }}
              onAct={(action) => void act([requestTarget(item)], action)}
            />
          )}
          ListEmptyComponent={
            <View
              className="items-center gap-4 px-8"
              style={{
                paddingTop:
                  query.isPending || query.isError ? 80 : Math.max(40, (listHeight - 260) / 2),
              }}>
              {query.isPending ? (
                <>
                  <ActivityIndicator className="text-textSecondary" />
                  <Text className="font-body text-body text-textSecondary">Loading requests</Text>
                </>
              ) : query.isError ? (
                <>
                  <Text className="text-center font-h2 text-h2 text-textPrimary">
                    Requests could not be loaded
                  </Text>
                  <Text className="text-center font-body text-body text-textSecondary">
                    Check the connection and try again.
                  </Text>
                  <Button
                    label="Try again"
                    variant="secondary"
                    busy={query.isFetching}
                    onPress={() => void refetch()}
                  />
                </>
              ) : (
                <>
                  <View className="h-16 w-16 items-center justify-center rounded-[20px] bg-surfaceMuted">
                    <Glyph name={GLYPH.approvals} size={28} tone="textSecondary" />
                  </View>
                  <Text
                    accessibilityRole="header"
                    className="text-center font-h1 text-h1 text-textPrimary">
                    {byPlatform('No Requests', 'No requests')}
                  </Text>
                  <Text className="text-center font-body text-body text-textSecondary">
                    No one is waiting to join. With Approval Mode on, people who open an invite wait
                    here until you let them in.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      router.push({
                        pathname: '/event/[id]/manage/settings',
                        params: { id: eventId },
                      })
                    }
                    className="ios:min-h-11 android:min-h-12 justify-center">
                    <Text className="text-center font-body text-body text-accentText">
                      {byPlatform('Approval Mode Settings', 'Approval mode settings')}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          }
          ListFooterComponent={
            people.length > 0 ? (
              <View className="gap-3 px-9 pt-3">
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  Photographers can upload from anywhere without checking in.{' '}
                  {IOS
                    ? 'Swipe left on a request to block that person.'
                    : 'Long press a request to select or block.'}
                </Text>
                {people.length > MAX_JOIN_REQUEST_BATCH || query.hasNextPage ? (
                  <Text className="font-caption text-caption text-textSecondary">
                    Select or approve up to 50 loaded requests at a time.
                  </Text>
                ) : null}
                {query.isFetchingNextPage ? (
                  <ActivityIndicator className="text-textSecondary" />
                ) : query.isError ? (
                  <Button
                    label="Try again"
                    variant="secondary"
                    busy={query.isFetching}
                    onPress={() => {
                      if (query.isFetchNextPageError) void query.fetchNextPage();
                      else void refetch();
                    }}
                  />
                ) : query.hasNextPage ? (
                  <Button
                    label="Load more requests"
                    variant="quiet"
                    disabled={busy}
                    onPress={() => void query.fetchNextPage()}
                  />
                ) : null}
              </View>
            ) : null
          }
        />
      </View>
      {IOS && selecting ? (
        <View
          style={{ position: 'absolute', left: 20, right: 20, bottom: Math.max(insets.bottom, 12) }}
          className="flex-row items-center gap-3 rounded-full border border-border bg-surfaceContainer p-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reject ${count} selected requests`}
            disabled={!ready || count === 0}
            onPress={() => void act(selected, 'reject')}
            className={`min-h-11 flex-1 items-center justify-center ${!ready || count === 0 ? 'opacity-40' : ''}`}>
            <Text className="font-buttonLabel text-buttonLabel text-textPrimary">Reject</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!ready || count === 0}
            onPress={() => void act(selected, 'approve')}
            className={`min-h-11 flex-1 items-center justify-center rounded-full bg-accent px-4 ${!ready || count === 0 ? 'opacity-40' : ''}`}>
            <Text className="font-buttonLabel text-buttonLabel text-background">
              Approve {count}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
