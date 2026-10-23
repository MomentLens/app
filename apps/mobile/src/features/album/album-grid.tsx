import type { MediaImage } from '@momentlens/shared-types';
import { FlashList } from '@shopify/flash-list';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import type { LargeTitleList } from '@/components/ui/large-title-screen.types';

import { formatDay } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';
import { PhotoTile } from './photo-tile';
import type { AlbumListItem } from './types';

type GridItem = AlbumListItem | { type: 'top'; key: string } | { type: 'empty'; key: string };
const AnimatedList = Animated.createAnimatedComponent(FlashList<GridItem>);

interface AlbumGridProps {
  items: readonly AlbumListItem[];
  // Signed thumbnails by media id, from useThumbnailMap.
  images: Readonly<Record<string, MediaImage>>;
  stickyIndices: readonly number[];
  isFetchingNextPage: boolean;
  onEndReached: () => void;
  scroll: LargeTitleList['scroll'];
  header: React.ReactElement;
  refreshing: boolean;
  onRefresh: () => void;
  onImageError: (mediaId: string) => void;
  ListEmptyComponent?: React.ReactElement;
}

// Virtualized 3-column photo grid using FlashList v2 (spec §4.9, hb §16).
// Sections are flattened into one array with 'header' and 'media' types (hb §16).
// Uniform square aspect ratio avoids measuring during virtualized scrolling.
export function AlbumGrid({
  items,
  images,
  stickyIndices,
  isFetchingNextPage,
  onEndReached,
  scroll,
  header,
  refreshing,
  onRefresh,
  onImageError,
  ListEmptyComponent,
}: AlbumGridProps) {
  const data = useMemo<GridItem[]>(
    () => [
      { type: 'top', key: 'top' },
      ...items,
      ...(items.length ? [] : [{ type: 'empty' as const, key: 'empty' }]),
    ],
    [items],
  );
  const sticky = useMemo(() => stickyIndices.map((index) => index + 1), [stickyIndices]);
  const renderItem = useCallback(
    ({ item }: { item: GridItem }) => {
      if (item.type === 'top') return header;
      if (item.type === 'empty') return ListEmptyComponent ?? null;
      if (item.type === 'header') {
        const { subEvent, numeral, count, isLive } = item;
        return (
          <View className="bg-background px-4 pb-2.5 pt-4">
            <View className="flex-row items-center gap-2">
              <Text className="font-serif text-lg font-bold text-accentText">
                {romanNumeral(numeral)}
              </Text>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                className="font-h2 text-h2 text-textPrimary">
                {subEvent.name}
              </Text>
              {isLive ? (
                <View accessibilityLabel="Live" className="h-2 w-2 rounded-full bg-danger" />
              ) : null}
            </View>
            <View className="mt-0.5 flex-row items-center justify-between">
              <Text
                numberOfLines={1}
                className="flex-1 font-caption text-caption text-textSecondary">
                {formatDay(new Date(subEvent.startsAt))} · {subEvent.venue.name}
              </Text>
              <Text className="ml-2 font-caption text-caption text-textSecondary">
                {count} {count === 1 ? 'photo' : 'photos'}
              </Text>
            </View>
          </View>
        );
      }

      return (
        <View className="p-[0.5px]">
          <PhotoTile mediaId={item.media.id} image={images[item.media.id]} onError={onImageError} />
        </View>
      );
    },
    [images, header, ListEmptyComponent, onImageError],
  );

  return (
    <AnimatedList
      {...scroll}
      data={data}
      numColumns={3}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.type}
      overrideItemLayout={(layout, item) => {
        if (item.type !== 'media') {
          layout.span = 3;
        } else {
          layout.span = 1;
        }
      }}
      stickyHeaderIndices={sticky}
      renderItem={renderItem}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      refreshing={refreshing}
      onRefresh={onRefresh}
      ListFooterComponent={
        isFetchingNextPage ? (
          <View className="py-6 items-center justify-center">
            <ActivityIndicator className="text-textSecondary" />
          </View>
        ) : null
      }
    />
  );
}
