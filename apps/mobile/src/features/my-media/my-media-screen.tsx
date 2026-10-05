import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';
import { FlashList } from '@shopify/flash-list';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { AnchoredMenu, type MenuAnchor } from '@/components/ui/anchored-menu';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH } from '@/components/ui/glyph';
import { useEventId } from '@/features/event-shell/event-id';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';
import { formatDay } from '@/features/events/format';
import { nextStatusChange, romanNumeral } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { enqueue, remove } from '@/features/upload-queue/queue';
import type { QueueItem } from '@/features/upload-queue/types';
import { useQueue } from '@/features/upload-queue/use-queue';
import { useNow } from '@/hooks/use-now';
import { useTokenColor } from '@/hooks/use-token-color';
import { useAuthStore } from '@/stores/auth';
import { pickMedia, pickedCapturedAt } from './picker';
import { PhotoTile } from './photo-tile';
import { QueueBanner } from './queue-banner';
import { mediaListItems, mediaSections, type MediaListItem } from './sections';
import { useMediaStatus } from './use-media-status';

const IOS = Platform.OS === 'ios';
const EMPTY_SCHEDULE: SubEvent[] = [];
// A Reanimated list, because on Android the frame's scroll handler collapses the large title.
const AnimatedList = Animated.createAnimatedComponent(FlashList<MediaListItem>);
export function MyMediaScreen() {
  const eventId = useEventId();
  const userId = useAuthStore((state) => state.userId);
  return <MediaContent key={`${eventId}/${userId}`} eventId={eventId} />;
}
function MediaContent({ eventId }: { eventId: string }) {
  const background = useTokenColor('background');
  const schedule = useSubEvents(eventId);
  const subEvents = schedule.data?.subEvents ?? EMPTY_SCHEDULE;
  const nextChange = useCallback((at: Date) => nextStatusChange(subEvents, at), [subEvents]);
  const now = useNow(nextChange);
  const queue = useQueue(eventId);
  const status = useMediaStatus(queue.userId, eventId);
  const sections = useMemo(
    () => mediaSections(subEvents, queue.items, now),
    [subEvents, queue.items, now],
  );
  const items = useMemo(
    () => (schedule.data ? mediaListItems(sections) : []),
    [schedule.data, sections],
  );
  const sticky = useMemo(
    () => items.flatMap((item, index) => (item.type === 'header' ? [index] : [])),
    [items],
  );
  const [picking, setPicking] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; item: QueueItem } | null>(null);
  // A cached schedule draws the sections offline, where adding to the queue matters most. Only
  // having no schedule at all is a load failure.
  const scheduleMissing = !schedule.data && schedule.isError;
  const live = currentSubEvent(subEvents, now);
  const subtitle = `${live ? `${live.name} is live · ` : ''}${queue.items.length} of yours`;

  async function add(subEventId: string) {
    const owner = queue.userId;
    if (!owner || picking) return;
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
  function confirmDelete(item: QueueItem) {
    Alert.alert(
      'Delete this photo from this phone?',
      'This removes the local copy. The photo in your gallery stays.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (useAuthStore.getState().userId !== item.userId) return;
            void remove(item.userId, item.id).catch(() =>
              setProblem('This photo could not be deleted. Try again.'),
            );
          },
        },
      ],
    );
  }
  async function refresh() {
    if (pulling) return;
    setPulling(true);
    queue.reload();
    await Promise.allSettled([schedule.refetch(), status.refresh(true)]);
    setPulling(false);
  }
  return (
    <EventTabScreen
      overlay={
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
      }
      renderList={({ scroll, header }) => (
        <AnimatedList
          {...scroll}
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          stickyHeaderIndices={sticky}
          maintainVisibleContentPosition={{ disabled: true }}
          contentContainerStyle={{ ...scroll.contentContainerStyle, backgroundColor: background }}
          refreshing={pulling}
          onRefresh={() => void refresh()}
          ListHeaderComponent={
            <>
              {header}
              <View className="px-5 pb-5 android:px-4">
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  {subtitle}
                </Text>
              </View>
              <QueueBanner counts={queue.counts} />
              {problem || queue.error || status.error || schedule.isError ? (
                <View className="px-5 pb-3">
                  <FormMessage
                    message={
                      problem ??
                      (queue.error
                        ? 'Your photos could not be read from this phone. Pull to refresh and try again.'
                        : 'The latest status could not be loaded. Your photos stay on this phone. Pull to refresh to try again.')
                    }
                  />
                </View>
              ) : null}
            </>
          }
          renderItem={({ item }) => {
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
                      busy={picking === section.key}
                      disabled={picking !== null || queue.loading || queue.error}
                      accessibilityHint={`Choose up to 50 photos for ${section.name}.`}
                      onPress={() => void add(section.key)}
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
                  />
                ))}
                {Array.from({ length: 3 - item.items.length }, (_, i) => (
                  <View key={`space-${i}`} style={{ flex: 1 }} />
                ))}
              </View>
            );
          }}
          ListEmptyComponent={
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
          }
        />
      )}
    />
  );
}
