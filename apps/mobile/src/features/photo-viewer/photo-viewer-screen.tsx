import type { MediaImage } from '@momentlens/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
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
import type { AlbumFilters } from '@/features/album/use-album';
import { cachedThumbnail } from '@/features/album/use-album-images';
import { tabHref } from '@/features/event-shell/tabs';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { formatDay, formatTime } from '@/features/events/format';

import { blurNotice } from './model';
import { PhotoPager } from './photo-pager';
import { usePhotoViewer } from './use-photo-viewer';

const IOS = Platform.OS === 'ios';
// The top bar's height under the status bar, on both platforms (HIG 44pt control in a 64pt row).
const BAR = 64;

const DELETE_TITLE = 'Delete this photo?';
const DELETE_DETAIL = 'It’s removed from the album for everyone and can’t be restored.';

// Home's single photo view, for Guests and the Admin (spec §2.5.6, design 18). A full-screen pager
// over what Home's grid shows under the same filters, with the photo's sub-event, capture time and
// uploader, the self-visible marker, the blur notice behind ⓘ, and Blur a region, Flag and Delete.
// A tap shows or hides everything but the marker, which stays (D-26). Download and Share are
// S-28's and are not drawn yet (D-179). The Recognized Faces strip waits for S-23 (D-176).
export function PhotoViewerScreen({
  eventId,
  mediaId,
  filters,
}: {
  eventId: string;
  mediaId: string;
  filters: AlbumFilters;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const client = useQueryClient();
  const eventQuery = useEvent(eventId);
  const viewer = usePhotoViewer(eventId, mediaId, filters);
  const { current, detail, actions } = viewer;

  const [chrome, setChrome] = useState(true);
  const [noticeFor, setNoticeFor] = useState<string | null>(null);

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace(tabHref(eventId, 'home'));
  }

  // The person lost the event, or the event was deleted, or their role became Photographer: the
  // shell under this screen shows what happened next (D-118).
  const lost = lostAccess(eventQuery.error) !== null;
  const photographer = eventQuery.data?.event.role === 'photographer';
  const closed = viewer.state === 'closed';
  useEffect(() => {
    if (lost || photographer || closed) close();
    // close() reads only the router and the event id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lost, photographer, closed]);

  const placeholders = useMemo(() => {
    const map: Record<string, MediaImage | undefined> = {};
    for (const slot of viewer.slots) {
      map[slot.media.id] = cachedThumbnail(client, eventId, slot.media);
    }
    return map;
  }, [client, eventId, viewer.slots]);

  const notice = blurNotice(detail);
  const noticeOpen = notice !== null && current !== undefined && noticeFor === current.id;
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

  function askToFlag() {
    Alert.alert('Flag this photo for the organizer to review?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Flag',
        onPress: () => {
          void viewer.flag().then((result) => {
            if (result === 'failed') {
              Alert.alert('Could not flag the photo', 'Check your connection and try again.');
            }
          });
        },
      },
    ]);
  }

  function deletePhoto() {
    void viewer.remove().then((result) => {
      if (result === 'not_uploader') {
        Alert.alert(
          'You can’t delete this photo',
          'Only the person who took it or the organizer can delete it.',
        );
      } else if (result === 'failed') {
        Alert.alert('Could not delete the photo', 'Check your connection and try again.');
      }
    });
  }

  // A destructive confirm with no Undo after it (D-130): an action sheet on iOS, as design 18
  // draws it, and a dialog on Android.
  function askToDelete() {
    if (IOS) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: DELETE_TITLE,
          message: DELETE_DETAIL,
          options: ['Delete Photo', 'Cancel'],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 1,
        },
        (index) => {
          if (index === 0) deletePhoto();
        },
      );
      return;
    }
    Alert.alert(DELETE_TITLE, DELETE_DETAIL, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: deletePhoto },
    ]);
  }

  function openBlur() {
    if (!current) return;
    router.push({
      pathname: '/blur/[eventId]/[mediaId]',
      params: { eventId, mediaId: current.id },
    });
  }

  if (viewer.state !== 'ready' || !current) {
    return (
      <View className="flex-1 bg-scrim" style={{ paddingTop: insets.top }}>
        <StatusBar style="light" />
        <View className="flex-row items-center px-4 android:pl-1" style={{ height: BAR }}>
          <CloseButton onPress={close} />
        </View>
        {viewer.state === 'loading' || viewer.state === 'closed' ? (
          <ActivityIndicator className="mt-24 text-onPhoto" />
        ) : (
          <View className="gap-4 px-8 pt-16">
            <Text className="font-h2 text-h2 text-onPhoto">
              {viewer.state === 'gone'
                ? 'This photo is no longer in the album'
                : 'Could not load the photo'}
            </Text>
            <Text className="font-body text-body text-onPhoto/80">
              {viewer.state === 'gone'
                ? 'It was deleted, or it is being processed again.'
                : 'Check your connection and try again.'}
            </Text>
            {viewer.state === 'error' ? (
              <PhotoButton label="Try Again" onPress={viewer.retryAlbum} />
            ) : null}
          </View>
        )}
      </View>
    );
  }

  const captured = new Date(current.capturedAt);
  const title = viewer.subEvent?.name ?? '';
  const subtitle = `${formatDay(captured)} · ${formatTime(captured)}`;
  const flagged = detail?.flaggedByMe === true;

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
            <CloseButton onPress={close} />
            <View className={`flex-1 ${IOS ? 'items-center' : ''}`}>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                className="font-h2 text-h2 text-onPhoto">
                {title}
              </Text>
              <Text numberOfLines={1} className="font-caption text-caption text-onPhoto/70">
                {subtitle}
              </Text>
            </View>
            {notice ? (
              <BarButton
                label="Why parts of this photo are blurred"
                glyph={GLYPH.info}
                onPress={() => setNoticeFor(noticeOpen ? null : current.id)}
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
          <View className="gap-2 px-1">
            {ownVariant ? (
              <View className="flex-row items-center gap-2">
                <Glyph name={GLYPH.ownVariant} size={16} tone="onPhoto" />
                <Text className="flex-1 font-body text-body text-onPhoto">
                  Your face here is visible only to you.
                </Text>
              </View>
            ) : null}
            <Text
              numberOfLines={1}
              className="font-bodySecondary text-bodySecondary text-onPhoto/70">
              {viewer.isOwnPhoto ? 'Taken by you' : `Taken by ${current.uploaderName}`}
            </Text>
          </View>
          <ActionBar>
            {actions.blur ? <Action label="Blur" glyph={GLYPH.blur} onPress={openBlur} /> : null}
            {actions.flag ? (
              <Action
                label={flagged ? 'Flagged' : 'Flag'}
                glyph={flagged ? GLYPH.flagged : GLYPH.flag}
                disabled={flagged || viewer.detailLoading || viewer.flagging}
                onPress={askToFlag}
              />
            ) : null}
            {actions.delete ? (
              <Action
                label="Delete"
                glyph={GLYPH.trash}
                tone="danger"
                disabled={viewer.deleting}
                onPress={askToDelete}
              />
            ) : null}
          </ActionBar>
        </View>
      ) : null}
    </View>
  );
}

function CloseButton({ onPress }: { onPress: () => void }) {
  if (IOS) {
    return (
      <GlassButton label="Close" onPress={onPress}>
        <Glyph name={GLYPH.close} size={20} tone="onPhoto" />
      </GlassButton>
    );
  }
  return <BarButton label="Back" glyph={GLYPH.back} onPress={onPress} />;
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

// A floating pill on iOS, as design 18 draws it, and a flat bar on Android (Material 3).
function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-row ios:rounded-full ios:bg-onPhoto/10 ios:px-2 ios:py-2 android:py-1">
      {children}
    </View>
  );
}

function Action({
  label,
  glyph,
  onPress,
  tone = 'onPhoto',
  disabled = false,
}: {
  label: string;
  glyph: GlyphName;
  onPress: () => void;
  tone?: 'onPhoto' | 'danger';
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-14 flex-1 items-center justify-center gap-1 rounded-full active:opacity-70 ${
        disabled ? 'opacity-50' : ''
      }`}>
      <Glyph name={glyph} size={24} tone={tone} />
      <Text
        className={`font-caption text-caption ${tone === 'danger' ? 'text-danger' : 'text-onPhoto'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function PhotoButton({ label, onPress }: { label: string; onPress: () => void }) {
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
