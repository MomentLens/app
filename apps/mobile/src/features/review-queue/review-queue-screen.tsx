import type { FlaggedPhoto, MediaImage, ReviewBlurRegion } from '@momentlens/shared-types';
import { FlashList } from '@shopify/flash-list';
import { onlineManager } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph, type GlyphName } from '@/components/ui/glyph';
import { Segmented } from '@/components/ui/segmented';
import { useThumbnailMap } from '@/features/album/use-album-images';
import { eventHref } from '@/features/event-shell/tabs';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { useTokenColor } from '@/hooks/use-token-color';
import { byPlatform } from '@/lib/copy';
import { presignedSource } from '@/lib/images';

import { BlurRegionCard } from './blur-region-card';
import { flaggedPhotos, flagSummary, openCount, reviewBlurRegions, uniqueMedia } from './model';
import {
  keepRegion,
  removeRegion,
  useFlaggedPhotos,
  useReviewBlurRegions,
  type ReviewOutcome,
} from './use-review-queue';

const IOS = Platform.OS === 'ios';

type Segment = 'flags' | 'regions';

const SEGMENTS = [
  { value: 'flags' as const, label: 'Flagged' },
  { value: 'regions' as const, label: byPlatform('Blurred Areas', 'Blurred areas') },
];

const OFFLINE = 'Connect to the internet to review.';
const FAILED = 'That did not save. Check your connection and try again.';

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

// The Admin's Review Queue (spec §2.5.7, design 25). Two segments, each its own paged list: photos
// Guests flagged, one row per photo however many flagged it, and blur regions Guests drew, one
// card per region (D-181). Opening a flagged photo shows it full screen with Keep and Delete. A
// region is kept or removed here. Every action needs a connection and is never queued.
export function ReviewQueueScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const background = useTokenColor('background');
  const foreground = useTokenColor('textPrimary');
  const event = useEvent(eventId);
  const online = useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline());
  const [segment, setSegment] = useState<Segment>('flags');
  // Ids with an action in flight. The ref answers a second tap at once; the state redraws.
  const busyIds = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const flags = useFlaggedPhotos(eventId);
  const regions = useReviewBlurRegions(eventId);
  const photos = useMemo(() => flaggedPhotos(flags.data), [flags.data]);
  const areas = useMemo(() => reviewBlurRegions(regions.data), [regions.data]);
  const photoMedia = useMemo(() => photos.map((entry) => entry.media), [photos]);
  const areaMedia = useMemo(() => uniqueMedia(areas.map((entry) => entry.media)), [areas]);
  const photoThumbs = useThumbnailMap(eventId, photoMedia);
  const areaThumbs = useThumbnailMap(eventId, areaMedia);

  // Back from the viewer, or back to the app: the lists may have moved.
  const refetchFlags = flags.refetch;
  const refetchRegions = regions.refetch;
  useFocusEffect(
    useCallback(() => {
      void refetchFlags();
      void refetchRegions();
    }, [refetchFlags, refetchRegions]),
  );

  // Only the Admin stays here. Anyone else, or someone who lost the event, goes back to the shell,
  // which shows what happened (D-118).
  useEffect(() => {
    const role = event.data?.event.role;
    if ((role !== undefined && role !== 'admin') || lostAccess(event.error))
      router.dismissTo(eventHref(eventId, role ?? 'admin'));
  }, [event.data?.event.role, event.error, eventId, router]);

  const run = useCallback(
    async (id: string, action: () => Promise<ReviewOutcome>, goneText: string) => {
      if (busyIds.current.has(id)) return;
      busyIds.current.add(id);
      setBusy(new Set(busyIds.current));
      setProblem(null);
      try {
        const outcome = await action();
        if (!mounted.current) return;
        // Offline needs no message of its own: the banner shows while the phone is offline.
        if (outcome === 'failed') setProblem(FAILED);
        else if (outcome === 'gone') setProblem(goneText);
      } finally {
        busyIds.current.delete(id);
        if (mounted.current) setBusy(new Set(busyIds.current));
      }
    },
    [],
  );

  const onKeep = useCallback(
    (item: ReviewBlurRegion) =>
      void run(
        item.region.id,
        () => keepRegion(eventId, item.region.id),
        'That blur was already removed, or its photo was deleted.',
      ),
    [eventId, run],
  );

  // Remove shows what was under the blur to everyone, so it asks first (D-181).
  const onRemove = useCallback(
    (item: ReviewBlurRegion) => {
      Alert.alert(
        'Remove this blur region?',
        'The area it covered will become visible to everyone again.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () =>
              void run(
                item.region.id,
                () => removeRegion(eventId, item.region.id, item.media.id),
                'That photo was deleted.',
              ),
          },
        ],
      );
    },
    [eventId, run],
  );

  const openPhoto = useCallback(
    (mediaId: string) =>
      router.push({ pathname: '/review-flag/[eventId]/[mediaId]', params: { eventId, mediaId } }),
    [eventId, router],
  );

  const title = byPlatform('Review Queue', 'Review queue');
  const loadedCount = segment === 'flags' ? photos.length : areas.length;
  const showProblem = !online && loadedCount > 0 ? OFFLINE : problem;

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
                headerBackButtonDisplayMode: 'minimal',
              }
            : { headerShown: false }
        }
      />
      {!IOS ? (
        <View style={{ paddingTop: insets.top }}>
          <View className="min-h-16 flex-row items-center pl-1 pr-2">
            <BarIconButton
              glyph={GLYPH.back}
              label="Back to Manage"
              onPress={() => router.back()}
            />
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              className="flex-1 px-2 font-h2 text-h2 text-textPrimary">
              {title}
            </Text>
          </View>
        </View>
      ) : null}
      <View className="px-4 pb-3 pt-2">
        <Segmented
          options={SEGMENTS}
          value={segment}
          onChange={setSegment}
          accessibilityLabel="Show flagged photos or blurred areas"
        />
      </View>
      {showProblem ? (
        <View className="px-5 pb-2">
          <FormMessage message={showProblem} />
        </View>
      ) : null}
      {segment === 'flags' ? (
        <FlashList
          key="flags"
          data={photos}
          keyExtractor={(entry) => entry.media.id}
          extraData={photoThumbs.images}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (flags.hasNextPage && !flags.isFetching && !flags.isError)
              void flags.fetchNextPage();
          }}
          ListHeaderComponent={
            photos.length > 0 ? (
              <CountHeader text={plural(openCount(flags.data), 'Photo', 'Photos')} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <FlaggedRow
              entry={item}
              image={photoThumbs.images[item.media.id]}
              first={index === 0}
              last={index === photos.length - 1}
              onPress={openPhoto}
              onImageError={photoThumbs.retry}
            />
          )}
          ListEmptyComponent={
            <ListState
              query={flags}
              glyph={GLYPH.flag}
              emptyTitle={byPlatform('Nothing Flagged', 'Nothing flagged')}
              emptyText="When a guest flags a photo, it shows up here for you to keep or remove."
              errorTitle="Flagged photos could not be loaded"
            />
          }
          ListFooterComponent={
            photos.length > 0 ? (
              <Footer
                query={flags}
                text="Open a photo to keep it or delete it. A deleted photo can’t be restored."
              />
            ) : null
          }
        />
      ) : (
        <FlashList
          key="regions"
          data={areas}
          keyExtractor={(entry) => entry.region.id}
          extraData={{ images: areaThumbs.images, busy, online }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ItemSeparatorComponent={() => <View className="h-4" />}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (regions.hasNextPage && !regions.isFetching && !regions.isError)
              void regions.fetchNextPage();
          }}
          ListHeaderComponent={
            areas.length > 0 ? (
              <CountHeader text={plural(openCount(regions.data), 'Area', 'Areas')} />
            ) : null
          }
          renderItem={({ item }) => (
            <BlurRegionCard
              eventId={eventId}
              item={item}
              image={areaThumbs.images[item.media.id]}
              disabled={!online || busy.has(item.region.id)}
              onKeep={onKeep}
              onRemove={onRemove}
              onImageError={areaThumbs.retry}
            />
          )}
          ListEmptyComponent={
            <ListState
              query={regions}
              glyph={GLYPH.blur}
              emptyTitle={byPlatform('No Blurred Areas', 'No blurred areas')}
              emptyText="When a guest blurs part of a photo, it shows up here for you to keep or remove."
              errorTitle="Blurred areas could not be loaded"
            />
          }
          ListFooterComponent={
            areas.length > 0 ? (
              <Footer
                query={regions}
                text="Anyone can blur part of a photo. Removing a blur shows what was under it to everyone again."
              />
            ) : null
          }
        />
      )}
    </View>
  );
}

function CountHeader({ text }: { text: string }) {
  return (
    <Text className="px-9 pb-3 pt-2 font-fieldLabel text-fieldLabel ios:text-textSecondary android:text-accentText">
      {text}
    </Text>
  );
}

interface ListQuery {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  hasNextPage: boolean;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => Promise<unknown>;
}

function ListState({
  query,
  glyph,
  emptyTitle,
  emptyText,
  errorTitle,
}: {
  query: ListQuery;
  glyph: GlyphName;
  emptyTitle: string;
  emptyText: string;
  errorTitle: string;
}) {
  if (query.isPending) {
    return (
      <View className="items-center gap-4 px-8 pt-20">
        <ActivityIndicator className="text-textSecondary" />
      </View>
    );
  }
  if (query.isError) {
    return (
      <View className="items-center gap-4 px-8 pt-20">
        <Text className="text-center font-h2 text-h2 text-textPrimary">{errorTitle}</Text>
        <Text className="text-center font-body text-body text-textSecondary">
          Check the connection and try again.
        </Text>
        <Button
          label={byPlatform('Try Again', 'Try again')}
          variant="secondary"
          busy={query.isFetching}
          onPress={() => void query.refetch()}
        />
      </View>
    );
  }
  return (
    <View className="items-center gap-4 px-8 pt-32">
      <View className="h-16 w-16 items-center justify-center rounded-[20px] bg-surfaceMuted">
        <Glyph name={glyph} size={28} tone="textSecondary" />
      </View>
      <Text accessibilityRole="header" className="text-center font-h1 text-h1 text-textPrimary">
        {emptyTitle}
      </Text>
      <Text className="text-center font-body text-body text-textSecondary">{emptyText}</Text>
    </View>
  );
}

function Footer({ query, text }: { query: ListQuery; text: string }) {
  return (
    <View className="gap-3 px-9 pt-3">
      <Text className="font-bodySecondary text-bodySecondary text-textSecondary">{text}</Text>
      {query.isFetchingNextPage ? (
        <ActivityIndicator className="text-textSecondary" />
      ) : query.isError ? (
        <Button
          label={byPlatform('Try Again', 'Try again')}
          variant="secondary"
          busy={query.isFetching}
          onPress={() => {
            if (query.isFetchNextPageError) void query.fetchNextPage();
            else void query.refetch();
          }}
        />
      ) : query.hasNextPage ? (
        <Button label="Load more" variant="quiet" onPress={() => void query.fetchNextPage()} />
      ) : null}
    </View>
  );
}

// One flagged photo, however many Guests flagged it, naming none of them (D-181). The rows sit in
// one grouped card, as design 25 draws them.
const FlaggedRow = memo(function FlaggedRow({
  entry,
  image,
  first,
  last,
  onPress,
  onImageError,
}: {
  entry: FlaggedPhoto;
  image: MediaImage | undefined;
  first: boolean;
  last: boolean;
  onPress: (mediaId: string) => void;
  onImageError: (mediaId: string) => void;
}) {
  const radius = IOS ? 26 : 20;
  const shape = {
    borderTopLeftRadius: first ? radius : 0,
    borderTopRightRadius: first ? radius : 0,
    borderBottomLeftRadius: last ? radius : 0,
    borderBottomRightRadius: last ? radius : 0,
  };
  const summary = flagSummary(entry.flagCount, entry.latestFlaggedAt);
  const heading = `${entry.subEventName} · ${entry.media.uploaderName}`;
  return (
    <View className="mx-4 bg-surface" style={shape}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${heading}. ${summary}`}
        accessibilityHint="Opens the photo to keep or delete it."
        onPress={() => onPress(entry.media.id)}
        className="min-h-[88px] flex-row items-center gap-4 px-4 py-3 active:opacity-70">
        <View className="h-16 w-16 overflow-hidden rounded-xl bg-surfaceMuted">
          {image ? (
            <Image
              source={presignedSource(image)}
              contentFit="cover"
              transition={150}
              accessibilityIgnoresInvertColors
              onError={() => onImageError(entry.media.id)}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
        </View>
        <View className="flex-1 gap-1">
          <Text numberOfLines={1} className="font-body text-body text-textPrimary">
            <Text className="font-buttonLabel">{entry.subEventName}</Text> ·{' '}
            {entry.media.uploaderName}
          </Text>
          <Text
            numberOfLines={1}
            className="font-bodySecondary text-bodySecondary text-textSecondary">
            {summary}
          </Text>
        </View>
        <Glyph name={GLYPH.chevron} size={IOS ? 14 : 24} tone={IOS ? 'textMuted' : 'textPrimary'} />
      </Pressable>
      {!last ? <View className="ml-24 h-px bg-border" /> : null}
    </View>
  );
});
