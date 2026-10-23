import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnchoredMenu, type MenuAnchor } from '@/components/ui/anchored-menu';
import { Button } from '@/components/ui/button';
import { Fab } from '@/components/ui/fab';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH } from '@/components/ui/glyph';
import { addMediaMode } from '@/features/album/album-state';
import { useAlbumSwitch } from '@/features/album/use-album-switch';
import { useEventId } from '@/features/event-shell/event-id';
import { useEvent } from '@/features/event-shell/use-event';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';
import { formatDay } from '@/features/events/format';
import { nextStatusChange, romanNumeral } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { keepOpenAdvice } from '@/features/upload-queue/background';
import { enqueue, remove, useRefusedBackgroundAccount } from '@/features/upload-queue/queue';
import { getCaptures, retryCapture, useCaptureDrafts } from '@/features/capture/runtime';
import type { CaptureDraft } from '@/features/capture/capture-store';
import { useQueue } from '@/features/upload-queue/use-queue';
import { useNow } from '@/hooks/use-now';
import { useTokenColor } from '@/hooks/use-token-color';
import { BottomTabInset } from '@/lib/platform';
import { useAuthStore } from '@/stores/auth';
import { checkInNotice } from '@/features/verification/notice';
import { useHeldReadings } from '@/features/verification/use-held-readings';
import { useLocationCheck } from '@/features/verification/use-gps-check';
import { checkInRows } from './check-in-banner';
import { pickMedia, pickedCapturedAt } from './picker';
import { PhotoTile } from './photo-tile';
import { ALBUM_CLOSED_ROW, KEEP_OPEN_ROW, StatusBanner } from './queue-banner';
import {
  deleteWarning,
  mediaRows,
  mediaSections,
  type MediaListItem,
  type MyMediaItem,
} from './sections';
import { CameraHint } from './camera-entry';
import { useMediaStatus } from './use-media-status';

const IOS = Platform.OS === 'ios';
const EMPTY_SCHEDULE: SubEvent[] = [];
const FAB_CLEARANCE = 56 + 16;
// A Reanimated list, because on Android the frame's scroll handler collapses the large title.
const AnimatedList = Animated.createAnimatedComponent(FlashList<MediaListItem>);
export function MyMediaScreen() {
  const eventId = useEventId();
  const userId = useAuthStore((state) => state.userId);
  return <MediaContent key={`${eventId}/${userId}`} eventId={eventId} />;
}
function MediaContent({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { captureSubEventId } = useLocalSearchParams<{ captureSubEventId?: string }>();
  const list = useRef<FlashListRef<MediaListItem>>(null);
  const background = useTokenColor('background');
  const schedule = useSubEvents(eventId);
  const event = useEvent(eventId);
  // While the album is closed "+ Add Media" adds nothing: a Guest's and a Photographer's button is
  // disabled, and the Admin's asks to open the album (D-161).
  const album = useAlbumSwitch(eventId);
  const albumClosed = event.data?.event.albumOpen === false;
  const addMode = addMediaMode(event.data?.event.role, event.data?.event.albumOpen);
  const heldIds = useHeldReadings(eventId);
  const subEvents = schedule.data?.subEvents ?? EMPTY_SCHEDULE;
  const nextChange = useCallback((at: Date) => nextStatusChange(subEvents, at), [subEvents]);
  const now = useNow(nextChange);
  const queue = useQueue(eventId);
  const checkIn = checkInNotice(subEvents, now, event.data?.verification, heldIds, queue.items);
  const location = useLocationCheck(Boolean(checkIn?.liveNames.length));
  // Only this account's refusal, and only while this event has photos that would upload now
  // (D-158).
  const refusedAccount = useRefusedBackgroundAccount();
  const keepOpen = keepOpenAdvice(refusedAccount, queue.userId, queue.counts);
  const captures = useCaptureDrafts(queue.userId, eventId);
  const status = useMediaStatus(queue.userId, eventId);
  const sections = useMemo(
    () =>
      mediaSections(
        subEvents,
        [
          ...queue.items,
          ...captures.drafts.filter((draft) => !queue.items.some((item) => item.id === draft.id)),
        ].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
        now,
      ),
    [subEvents, queue.items, captures.drafts, now],
  );
  const items = useMemo(
    () => mediaRows(schedule.data ? sections : null),
    [schedule.data, sections],
  );
  const sticky = useMemo(
    () => items.flatMap((item, index) => (item.type === 'header' ? [index] : [])),
    [items],
  );
  const [picking, setPicking] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [problem, setProblem] = useState<string>();
  const showCaptureSection = useCallback(() => {
    const view = list.current;
    if (!captureSubEventId || !view) return;
    const index = items.findIndex(
      (item) => item.type === 'header' && item.section.key === captureSubEventId,
    );
    const layout = index < 0 ? undefined : view.getLayout(index);
    if (!layout) return;
    // scrollToIndex records its target as the list's offset even when the list is too short to
    // reach it, and the section's header then sticks while it is still on screen. scrollToOffset
    // moves the native view only, and the list reads the offset it reached from the scroll event.
    view.scrollToOffset({ offset: layout.y, animated: false });
    router.setParams({ captureSubEventId: undefined });
  }, [captureSubEventId, items, router]);
  useFocusEffect(
    useCallback(() => {
      const frame = requestAnimationFrame(showCaptureSection);
      return () => cancelAnimationFrame(frame);
    }, [showCaptureSection]),
  );
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; item: MyMediaItem } | null>(null);
  // A cached schedule draws the sections offline, where adding to the queue matters most. Only
  // having no schedule at all is a load failure.
  const scheduleMissing = !schedule.data && schedule.isError;
  const live = currentSubEvent(subEvents, now);
  const subtitle = `${live ? `${live.name} is live · ` : ''}${queue.items.length + captures.drafts.length} of yours`;
  // The camera opens only while a sub-event is live (spec §2.5.4), from a floating button on both
  // platforms (D-112). Android lays the tab out above its bar; iOS draws the bar over the content.
  const camera =
    schedule.data && live
      ? {
          label: `Open camera for ${live.name}`,
          onPress: () => router.push({ pathname: '/capture/[eventId]', params: { eventId } }),
        }
      : null;

  async function add(subEventId: string) {
    const owner = queue.userId;
    if (!owner || picking || addMode !== 'add') return;
    setPicking(subEventId);
    setProblem(undefined);
    let added = 0;
    try {
      const assets = await pickMedia();
      for (const asset of assets) {
        if (useAuthStore.getState().userId !== owner) break;
        // Keep the picker's capture time before it discards its temporary file (D-98).
        await enqueue(owner, eventId, subEventId, {
          uri: asset.uri,
          capturedAt: pickedCapturedAt(asset.exif),
        });
        added++;
      }
    } catch {
      if (useAuthStore.getState().userId === owner)
        setProblem(
          added
            ? `${added} ${added === 1 ? 'photo was' : 'photos were'} added. The remaining photos could not be saved. Pick those again.`
            : 'The photos could not be saved on this phone. Check free space and try again.',
        );
    } finally {
      setPicking(null);
    }
  }
  function retry(draft: CaptureDraft) {
    const proceed = () => {
      void retryCapture(draft).catch((error: unknown) => {
        if (useAuthStore.getState().userId === draft.userId)
          setProblem(
            error instanceof Error
              ? error.message
              : 'The gallery save could not finish. Try again.',
          );
      });
    };
    Alert.alert(
      draft.galleryState === 'saved' ? 'Queue this photo?' : 'Retry the gallery save?',
      draft.galleryState === 'uncertain' || draft.galleryState === 'failed'
        ? 'The last save did not finish. This photo may already be in your gallery. Retrying may create another gallery copy. Upload starts only after the save succeeds.'
        : draft.galleryState === 'saved'
          ? 'The original is already in your gallery. This retries adding the photo to the upload queue.'
          : 'MomentLens saves the original to your gallery before uploading. The photo stays on this phone if the save fails.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: proceed },
      ],
    );
  }
  function confirmDelete(item: MyMediaItem) {
    Alert.alert('Delete this photo from this phone?', deleteWarning(item), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (useAuthStore.getState().userId !== item.userId) return;
          const deleted =
            item.state === 'capture_draft'
              ? getCaptures().then((store) => store.remove(item.userId, item.id))
              : remove(item.userId, item.id);
          void deleted.catch(() => setProblem('This photo could not be deleted. Try again.'));
        },
      },
    ]);
  }
  const emptyNotice = (
    <View className="items-center gap-3 px-8 py-12">
      {schedule.isPending || queue.loading ? (
        <ActivityIndicator className="text-textSecondary" />
      ) : (
        <>
          <Text className="text-center font-h2 text-h2 text-textPrimary">
            {queue.error || scheduleMissing
              ? 'Your photos could not be loaded'
              : 'Your photos will show here'}
          </Text>
          <Text className="text-center font-body text-body text-textSecondary">
            {queue.error || scheduleMissing
              ? 'Pull to refresh and try again.'
              : 'Add photos once a sub-event has started. This tab keeps the photos you add on this phone.'}
          </Text>
        </>
      )}
    </View>
  );
  async function refresh() {
    if (pulling) return;
    setPulling(true);
    queue.reload();
    captures.reload();
    await Promise.allSettled([event.refetch(), schedule.refetch(), status.refresh(true)]);
    setPulling(false);
  }
  return (
    <EventTabScreen
      bottomInset={camera ? FAB_CLEARANCE : 0}
      overlay={
        <>
          <AnchoredMenu
            anchor={menu?.anchor ?? null}
            onClose={() => setMenu(null)}
            items={
              menu
                ? [
                    {
                      key: 'delete',
                      label: 'Delete',
                      glyph: GLYPH.trash,
                      destructive: true,
                      onPress: () => confirmDelete(menu.item),
                    },
                  ]
                : []
            }
          />
          {camera ? (
            <Fab
              glyph={GLYPH.camera}
              bottom={IOS ? insets.bottom + BottomTabInset + 16 : 16}
              {...camera}
            />
          ) : null}
        </>
      }
      renderList={({ scroll, header }) => (
        <AnimatedList
          ref={list}
          onLoad={showCaptureSection}
          {...scroll}
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          stickyHeaderIndices={sticky}
          maintainVisibleContentPosition={{ disabled: true }}
          contentContainerStyle={{ ...scroll.contentContainerStyle, backgroundColor: background }}
          refreshing={pulling}
          onRefresh={() => void refresh()}
          renderItem={({ item }) => {
            if (item.type === 'top')
              return (
                <View>
                  {header}
                  <View className="px-5 pb-5 android:px-4">
                    <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                      {subtitle}
                    </Text>
                  </View>
                  <StatusBanner
                    counts={queue.counts}
                    rows={[
                      ...(albumClosed ? [ALBUM_CLOSED_ROW] : []),
                      ...checkInRows(checkIn, location, () =>
                        router.push({ pathname: '/scan-venue/[eventId]', params: { eventId } }),
                      ),
                      ...(keepOpen ? [KEEP_OPEN_ROW] : []),
                    ]}
                  />
                  {schedule.data && !live ? <CameraHint schedule={subEvents} now={now} /> : null}
                  {problem ||
                  album.problem ||
                  queue.error ||
                  captures.error ||
                  status.error ||
                  schedule.isError ? (
                    <View className="px-5 pb-3">
                      <FormMessage
                        message={
                          problem ??
                          album.problem ??
                          (queue.error
                            ? 'Your photos could not be read from this phone. Pull to refresh and try again.'
                            : 'The latest status could not be loaded. Your photos stay on this phone. Pull to refresh to try again.')
                        }
                      />
                    </View>
                  ) : null}
                </View>
              );
            if (item.type === 'notice') return emptyNotice;
            if (item.type === 'header') {
              const section = item.section;
              const date = section.subEvent ? formatDay(new Date(section.subEvent.startsAt)) : null;
              const venue = subEvents.find((sub) => sub.id === section.key)?.venue.name;
              return (
                <View className="flex-row items-center gap-3 bg-background px-5 pb-3 pt-4 android:px-4">
                  <View className="flex-1 gap-1">
                    <View className="flex-row items-center gap-2">
                      {section.number ? (
                        <Text className="font-h2 text-body text-accentText">
                          {romanNumeral(section.number)}
                        </Text>
                      ) : null}
                      <Text
                        accessibilityRole="header"
                        className="shrink font-h2 text-h2 text-textPrimary">
                        {section.name}
                      </Text>
                      {live?.id === section.key ? (
                        <View
                          accessibilityLabel="Live"
                          className="h-2 w-2 rounded-full bg-danger"
                        />
                      ) : null}
                    </View>
                    <Text className="font-caption text-caption text-textSecondary">
                      {date ? `${date}${venue ? ` · ${venue}` : ''} · ` : ''}
                      {section.items.length} {section.items.length === 1 ? 'photo' : 'photos'}
                    </Text>
                  </View>
                  {section.canAdd ? (
                    <Button
                      label={IOS ? 'Add Media' : 'Add media'}
                      icon="plus"
                      variant={IOS ? 'secondary' : 'tonal'}
                      size="small"
                      busy={picking === section.key || (addMode === 'ask-to-open' && album.busy)}
                      disabled={
                        picking !== null || queue.loading || queue.error || addMode === 'disabled'
                      }
                      accessibilityHint={
                        addMode === 'disabled'
                          ? 'The album is closed. New photos wait until the organizer opens it.'
                          : addMode === 'ask-to-open'
                            ? 'The album is closed. Asks to open it first.'
                            : `Choose up to 50 photos for ${section.name}.`
                      }
                      onPress={() => {
                        if (addMode === 'ask-to-open') album.askToOpen();
                        else void add(section.key);
                      }}
                    />
                  ) : null}
                </View>
              );
            }
            if (item.type === 'empty')
              return (
                <View className="px-5 pb-6">
                  <Text className="font-bodySecondary text-bodySecondary text-textMuted">
                    No photos from this phone yet.
                  </Text>
                </View>
              );
            return (
              <View className="flex-row gap-0.5 pb-0.5">
                {item.items.map((photo) => (
                  <PhotoTile
                    key={photo.id}
                    item={photo}
                    eventId={eventId}
                    removed={item.removed}
                    onDelete={() => confirmDelete(photo)}
                    onMenu={(anchor) => setMenu({ anchor, item: photo })}
                    onRetry={() => {
                      if (photo.state === 'capture_draft') retry(photo);
                    }}
                  />
                ))}
                {Array.from({ length: 3 - item.items.length }, (_, i) => (
                  <View key={`space-${i}`} style={{ flex: 1 }} />
                ))}
              </View>
            );
          }}
        />
      )}
    />
  );
}
