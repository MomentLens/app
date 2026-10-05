import { FlashList } from '@shopify/flash-list';
import { useCallback } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { formatDay } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';
import { PhotoTile } from './photo-tile';
import type { AlbumListItem } from './types';
import { useThumbnailMap } from './use-album-images';

interface AlbumGridProps {
  eventId: string;
  items: readonly AlbumListItem[];
  stickyIndices: readonly number[];
  isFetchingNextPage: boolean;
  onEndReached: () => void;
  ListHeaderComponent?: React.ReactElement;
  ListEmptyComponent?: React.ReactElement;
}

// Virtualized 3-column photo grid using FlashList v2 (spec §4.9, hb §16).
// Sections are flattened into one array with 'header' and 'media' types (hb §16).
// Uniform square aspect ratio avoids measuring during virtualized scrolling.
export function AlbumGrid({
  eventId,
  items,
  stickyIndices,
  isFetchingNextPage,
  onEndReached,
  ListHeaderComponent,
  ListEmptyComponent,
}: AlbumGridProps) {
  // Extract all media IDs in the current items to resolve thumbnails in batches
  const mediaIds = items.flatMap((item) => (item.type === 'media' ? [item.media.id] : []));
  const { images, loadedChunkIds } = useThumbnailMap(eventId, mediaIds);

  const renderItem = useCallback(
    ({ item }: { item: AlbumListItem }) => {
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
          <PhotoTile
            media={item.media}
            image={images[item.media.id]}
            isResolved={loadedChunkIds.has(item.media.id)}
          />
        </View>
      );
    },
    [images, loadedChunkIds],
  );

  return (
    <FlashList
      data={items as AlbumListItem[]}
      numColumns={3}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.type}
      overrideItemLayout={(layout, item) => {
        if (item.type === 'header') {
          layout.span = 3;
        } else {
          layout.span = 1;
        }
      }}
      stickyHeaderIndices={stickyIndices as number[]}
      renderItem={renderItem}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
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
