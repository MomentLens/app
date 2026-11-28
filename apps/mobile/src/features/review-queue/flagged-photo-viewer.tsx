import type { MediaImage } from '@momentlens/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph, type GlyphName } from '@/components/ui/glyph';
import { cachedThumbnail } from '@/features/album/use-album-images';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { formatDay, formatTime } from '@/features/events/format';
import { blurNotice } from '@/features/photo-viewer/model';
import { PhotoPager } from '@/features/photo-viewer/photo-pager';
import { byPlatform } from '@/lib/copy';
import { useAuthStore } from '@/stores/auth';

import { flagTitle } from './model';
import {
  deleteFlaggedPhoto,
  keepFlags,
  useFlaggedViewer,
  type ReviewOutcome,
} from './use-review-queue';

const IOS = Platform.OS === 'ios';
// The top bar's height under the status bar, as S-22's viewer has it.
const BAR = 64;

// The Admin's moderation viewer for flagged photos (spec §2.5.7, D-181, design 25). S-22's pager
// over the loaded flagged photos in the queue's order, with the self-visible marker, the blur
// notice behind ⓘ, and Keep and Delete. Keep acts at once and marks every open flag on the photo
// kept. Delete is permanent and confirms first (D-130). Either moves on to the next flagged photo,
// and the viewer closes when none are left.
export function FlaggedPhotoViewer({ eventId, mediaId }: { eventId: string; mediaId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useQueryClient();
  const userId = useAuthStore((state) => state.userId);
  const eventQuery = useEvent(eventId);
  const viewer = useFlaggedViewer(eventId, mediaId);
  const { current, detail } = viewer;

  const [chrome, setChrome] = useState(true);
  const [noticeFor, setNoticeFor] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const workingNow = useRef(false);

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/event/[id]/manage/review-queue', params: { id: eventId } });
  }

  // Only the Admin moderates. Losing the event or the Admin role closes the viewer, and the screen
  // under it decides what shows next (D-118).
  const lost = lostAccess(eventQuery.error) !== null;
  const role = eventQuery.data?.event.role;
  const notAdmin = role !== undefined && role !== 'admin';
  const closed = viewer.state === 'closed';
  useEffect(() => {
    if (lost || notAdmin || closed) close();
    // close() reads only the router and the event id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lost, notAdmin, closed]);

  const placeholders = useMemo(() => {
    const map: Record<string, MediaImage | undefined> = {};
    for (const slot of viewer.slots)
      map[slot.media.id] = cachedThumbnail(client, eventId, slot.media);
    return map;
  }, [client, eventId, viewer.slots]);

  const notice = blurNotice(detail);
  const currentId = current?.media.id;
  const noticeOpen = notice !== null && currentId !== undefined && noticeFor === currentId;
  const shownImage = viewer.slots.find((slot) => slot.index === viewer.index)?.image;
  const ownVariant = shownImage?.isOwnVariant === true;

  function onTap() {
    if (noticeFor !== null) setNoticeFor(null);
    else setChrome((shown) => !shown);
  }

  function onTurn(direction: 1 | -1) {
    const next = viewer.slots.find((slot) => slot.index === viewer.index + direction);
    if (next) viewer.goTo(next.media.id);
  }

  async function act(action: () => Promise<ReviewOutcome>, failedTitle: string) {
    if (workingNow.current) return;
    workingNow.current = true;
    setWorking(true);
    try {
      const outcome = await action();
      if (outcome === 'offline') {
        Alert.alert('You’re offline', 'Connect to the internet to review this photo.');
      } else if (outcome === 'failed') {
        Alert.alert(failedTitle, 'Check your connection and try again.');
      }
    } finally {
      workingNow.current = false;
      setWorking(false);
    }
  }

  function keep() {
    if (!current) return;
    const target = current.media.id;
    void act(() => keepFlags(eventId, target), 'Could not keep the photo');
  }

  // A destructive confirm with no Undo after it (D-130): an action sheet on iOS, as design 25 draws
  // it, and a dialog on Android.
  function askToDelete() {
    if (!current) return;
    const target = current.media.id;
    const theirs = current.media.uploaderUserId !== userId;
    const detailText = theirs
      ? `It’s removed from the album for everyone, ${current.media.uploaderName} included, and can’t be restored.`
      : 'It’s removed from the album for everyone and can’t be restored.';
    const run = () =>
      void act(() => deleteFlaggedPhoto(eventId, target), 'Could not delete the photo');
    if (IOS) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          message: detailText,
          options: ['Delete Photo', 'Cancel'],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 1,
        },
        (index) => {
          if (index === 0) run();
        },
      );
      return;
    }
    Alert.alert('Delete this photo?', detailText, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: run },
    ]);
  }

  if (viewer.state !== 'ready' || !current) {
    return (
      <View className="flex-1 bg-scrim" style={{ paddingTop: insets.top }}>
        <StatusBar style="light" />
        <View className="flex-row items-center px-4 android:pl-1" style={{ height: BAR }}>
          <BarButton label="Close" glyph={GLYPH.close} onPress={close} />
        </View>
        {viewer.state === 'loading' || viewer.state === 'closed' ? (
          <ActivityIndicator className="mt-24 text-onPhoto" />
        ) : (
          <View className="gap-4 px-8 pt-16">
            <Text className="font-h2 text-h2 text-onPhoto">
              {viewer.state === 'gone'
                ? 'This photo is no longer flagged'
                : 'Could not load the photo'}
            </Text>
            <Text className="font-body text-body text-onPhoto/80">
              {viewer.state === 'gone'
                ? 'Someone kept or deleted it, or it is being processed again.'
                : 'Check your connection and try again.'}
            </Text>
            {viewer.state === 'error' ? (
              <ViewerButton
                label={byPlatform('Try Again', 'Try again')}
                onPress={viewer.retryList}
              />
            ) : null}
          </View>
        )}
      </View>
    );
  }

  const captured = new Date(current.media.capturedAt);
  const subtitle = `${current.subEventName} · ${current.media.uploaderName} · ${formatDay(captured)}, ${formatTime(captured)}`;

  return (
    <View className="flex-1 bg-scrim">
      <StatusBar style="light" hidden={!chrome} />
      <PhotoPager
        slots={viewer.slots}
        currentIndex={viewer.index}
        count={viewer.count}
        badgeTop={chrome ? insets.top + BAR + 12 : insets.top + 12}
        placeholders={placeholders}
        onTurn={onTurn}
        onTap={onTap}
        onImageError={viewer.retryImage}
        onRetry={viewer.retryImage}
      />

      {chrome ? (
        <View
          className="absolute left-0 right-0 top-0 bg-scrim/80"
          style={{ paddingTop: insets.top }}>
          <View className="flex-row items-center gap-3 px-4 android:pl-1" style={{ height: BAR }}>
            <BarButton label="Close" glyph={GLYPH.close} onPress={close} />
            <View className={`flex-1 ${IOS ? 'items-center' : ''}`}>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                className="font-h2 text-h2 text-onPhoto">
                {flagTitle(current.flagCount, IOS)}
              </Text>
              <Text numberOfLines={1} className="font-caption text-caption text-onPhoto/70">
                {subtitle}
              </Text>
            </View>
            {notice ? (
              <BarButton
                label="Why parts of this photo are blurred"
                glyph={GLYPH.info}
                onPress={() => setNoticeFor(noticeOpen ? null : current.media.id)}
              />
            ) : (
              <View className="h-11 w-11" />
            )}
          </View>
        </View>
      ) : null}

      {chrome && noticeOpen && notice ? (
        <View
          accessibilityLiveRegion="polite"
          className="absolute right-4 max-w-[300px] gap-1 rounded-2xl bg-onPhoto px-4 py-3"
          style={{ top: insets.top + BAR + 8 }}>
          {notice.map((line) => (
            <Text key={line} className="font-body text-body text-scrim">
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      {chrome ? (
        <View
          className="absolute bottom-0 left-0 right-0 gap-4 bg-scrim/80 px-4 pt-4"
          style={{ paddingBottom: insets.bottom + 8 }}>
          {ownVariant ? (
            <View className="flex-row items-center justify-center gap-2 px-1">
              <Glyph name={GLYPH.ownVariant} size={16} tone="onPhoto" />
              <Text className="font-body text-body text-onPhoto">
                Your face here is visible only to you.
              </Text>
            </View>
          ) : null}
          <Text className="px-4 text-center font-bodySecondary text-bodySecondary text-onPhoto/80">
            Keep clears the flags. Delete removes the photo for everyone, and it can’t be restored.
          </Text>
          <View className="flex-row gap-3">
            <ModerationButton label="Keep" disabled={working} onPress={keep} />
            <ModerationButton label="Delete" danger disabled={working} onPress={askToDelete} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function BarButton({
  label,
  glyph,
  onPress,
}: {
  label: string;
  glyph: GlyphName;
  onPress: () => void;
}) {
  if (IOS) {
    return (
      <GlassButton label={label} onPress={onPress}>
        <Glyph name={glyph} size={20} tone="onPhoto" />
      </GlassButton>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-12 w-12 items-center justify-center rounded-full active:bg-onPhoto/10">
      <Glyph name={glyph} tone="onPhoto" />
    </Pressable>
  );
}

// Design 25's two large buttons: Delete is red text on iOS's dark capsule, and a red fill on
// Android, as Material 3 draws a destructive filled button.
function ModerationButton({
  label,
  danger = false,
  disabled,
  onPress,
}: {
  label: string;
  danger?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const fill = danger && !IOS ? 'bg-danger' : 'bg-onPhoto/15';
  const text = danger && IOS ? 'text-danger' : 'text-onPhoto';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`ios:min-h-[50px] android:min-h-14 flex-1 items-center justify-center rounded-full ${fill} active:opacity-70 ${
        disabled ? 'opacity-50' : ''
      }`}>
      <Text className={`font-buttonLabel text-buttonLabel ${text}`}>{label}</Text>
    </Pressable>
  );
}

function ViewerButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="ios:min-h-[50px] android:min-h-14 items-center justify-center rounded-full bg-accent px-6 active:opacity-70">
      <Text className="font-buttonLabel text-buttonLabel text-scrim">{label}</Text>
    </Pressable>
  );
}
