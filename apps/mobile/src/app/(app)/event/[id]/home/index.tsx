import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, Text, View } from 'react-native';

import { GLYPH } from '@/components/ui/glyph';
import { useEventId } from '@/features/event-shell/event-id';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';
import { tabHref } from '@/features/event-shell/tabs';
import { useEvent } from '@/features/event-shell/use-event';
import { formatEventDates } from '@/features/events/format';
import { ActiveFilterPill } from '@/features/album/active-filter-pill';
import { AlbumGrid } from '@/features/album/album-grid';
import {
  AlbumLoadFailed,
  AllEmpty,
  SubEventEmpty,
  UploaderEmpty,
} from '@/features/album/empty-states';
import { MoreSubEventsSheet } from '@/features/album/more-sub-events-sheet';
import { isPreEvent as beforeFirstStart, nextCountdownChange } from '@/features/album/pre-event';
import { PreEventView } from '@/features/album/pre-event-view';
import { buildAlbumListItems } from '@/features/album/sections';
import { SubEventChips } from '@/features/album/sub-event-chips';
import { UploaderSheet, type UploaderFilter } from '@/features/album/uploader-sheet';
import { useAlbum, useUploaders } from '@/features/album/use-album';
import { useThumbnailMap } from '@/features/album/use-album-images';
import { nextStatusChange } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useNow } from '@/hooks/use-now';

const EMPTY_SCHEDULE: SubEvent[] = [];

// Home, a Guest's and the Admin's landing tab: the album and its filters in one screen (spec §2.5.2).
// A Photographer is redirected to My Media (spec §4.10, D-118).
export default function HomeTab() {
  const eventId = useEventId();
  const { subEventId: initialSubEventId } = useLocalSearchParams<{
    id: string;
    subEventId?: string;
  }>();

  const eventQuery = useEvent(eventId);
  const event = eventQuery.data?.event;

  // A Photographer never reaches Home (spec §4.10, D-118)
  if (event && event.role === 'photographer') {
    return <Redirect href={tabHref(eventId, 'media')} />;
  }

  return <HomeContent eventId={eventId} initialSubEventId={initialSubEventId} />;
}

function HomeContent({
  eventId,
  initialSubEventId,
}: {
  eventId: string;
  initialSubEventId?: string;
}) {
  const eventQuery = useEvent(eventId);
  const event = eventQuery.data?.event;
  const scheduleQuery = useSubEvents(eventId);
  const subEvents = scheduleQuery.data?.subEvents ?? EMPTY_SCHEDULE;

  // Before the first start the countdown moves too, at local midnight and on the day by the hour.
  const nextChange = useCallback(
    (at: Date) => {
      const status = nextStatusChange(subEvents, at);
      const first = subEvents[0];
      if (first === undefined || !beforeFirstStart(subEvents, at)) return status;
      const countdown = nextCountdownChange(new Date(first.startsAt), at);
      return status === null || countdown < status ? countdown : status;
    },
    [subEvents],
  );
  const now = useNow(nextChange);
  const liveSubEvent = currentSubEvent(subEvents, now);

  // Active filters
  const [selectedSubEventId, setSelectedSubEventId] = useState<string | null>(
    initialSubEventId ?? null,
  );
  const [selectedUploader, setSelectedUploader] = useState<UploaderFilter | undefined>(undefined);
  const selectedUploaderId = selectedUploader?.id;

  // Sheets
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);

  // Album query
  const albumQuery = useAlbum(eventId, {
    subEventId: selectedSubEventId ?? undefined,
    uploaderId: selectedUploaderId,
  });
  const uploadersQuery = useUploaders(eventId);

  const [pulling, setPulling] = useState(false);

  // Flatten media items across loaded pages
  const allMedia = useMemo(
    () => albumQuery.data?.pages.flatMap((page) => page.media) ?? [],
    [albumQuery.data?.pages],
  );

  // Extract section counts from first page
  const sectionCountsMap = useMemo(() => {
    const counts: Record<string, number> = {};
    const firstPageCounts = albumQuery.data?.pages[0]?.sectionCounts;
    if (firstPageCounts) {
      for (const item of firstPageCounts) {
        counts[item.subEventId] = item.count;
      }
    }
    return counts;
  }, [albumQuery.data?.pages]);

  const totalPhotosCount = useMemo(() => {
    if (Object.keys(sectionCountsMap).length > 0) {
      return Object.values(sectionCountsMap).reduce((sum, n) => sum + n, 0);
    }
    return allMedia.length;
  }, [sectionCountsMap, allMedia.length]);

  // Pre-event check: shown until the first sub-event starts (D-138, D-148)
  const isPreEvent = beforeFirstStart(subEvents, now);

  // Thumbnails for every loaded photo, signed in batches of 50 (D-148).
  const thumbnails = useThumbnailMap(eventId, allMedia);

  // Build flattened items for FlashList v2
  const { items, stickyIndices, unknownSubEvent } = useMemo(
    () =>
      buildAlbumListItems(
        allMedia,
        subEvents,
        sectionCountsMap,
        liveSubEvent?.id ?? null,
        thumbnails.omitted,
      ),
    [allMedia, subEvents, sectionCountsMap, liveSubEvent?.id, thumbnails.omitted],
  );

  // A photo filed under a sub-event this phone has not loaded yet, one an Admin just added, has
  // no section to sit in. Fetch the schedule once each time that starts happening.
  const refetchSchedule = scheduleQuery.refetch;
  useEffect(() => {
    if (unknownSubEvent) void refetchSchedule();
  }, [unknownSubEvent, refetchSchedule]);

  const refresh = async () => {
    if (pulling) return;
    setPulling(true);
    await Promise.allSettled([
      albumQuery.refetch(),
      scheduleQuery.refetch(),
      uploadersQuery.refetch(),
    ]);
    setPulling(false);
  };

  const selectedSubEvent = useMemo(
    () => subEvents.find((s) => s.id === selectedSubEventId),
    [subEvents, selectedSubEventId],
  );

  // Subtitle under event name
  const subtitle = useMemo(() => {
    if (isPreEvent) {
      if (!event) return undefined;
      return `${formatEventDates(new Date(event.startsAt), new Date(event.endsAt))}`;
    }
    const photos = `${totalPhotosCount} ${totalPhotosCount === 1 ? 'photo' : 'photos'}`;
    return liveSubEvent ? `${liveSubEvent.name} is live · ${photos}` : photos;
  }, [isPreEvent, event, liveSubEvent, totalPhotosCount]);

  if (isPreEvent && event) {
    return (
      <EventTabScreen
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void refresh()} />}>
        <View className="px-5 pb-4 android:px-4">
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
            {subtitle}
          </Text>
        </View>
        <PreEventView event={event} subEvents={subEvents} now={now} />
      </EventTabScreen>
    );
  }

  const headerActions = [
    {
      key: 'filter',
      label: 'Filter',
      glyph: GLYPH.filter,
      onPress: () => setFilterSheetOpen(true),
    },
  ];

  return (
    <>
      <EventTabScreen
        actions={headerActions}
        renderList={({ scroll, header }) => (
          <AlbumGrid
            items={items}
            images={thumbnails.images}
            stickyIndices={stickyIndices}
            isFetchingNextPage={albumQuery.isFetchingNextPage}
            onEndReached={() => {
              if (albumQuery.hasNextPage && !albumQuery.isFetchingNextPage) {
                void albumQuery.fetchNextPage();
              }
            }}
            ListHeaderComponent={
              <View>
                {header}
                {/* Subtitle with live status and count */}
                <View className="flex-row items-center gap-1.5 px-5 pb-1 android:px-4">
                  {liveSubEvent ? (
                    <View accessibilityLabel="Live" className="h-2 w-2 rounded-full bg-danger" />
                  ) : null}
                  <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                    {subtitle}
                  </Text>
                </View>

                {/* Sub-event chips row */}
                <SubEventChips
                  subEvents={subEvents}
                  selectedId={selectedSubEventId}
                  liveSubEventId={liveSubEvent?.id ?? null}
                  onSelect={setSelectedSubEventId}
                  onOpenMore={() => setMoreSheetOpen(true)}
                />

                {/* Active uploader filter pill, shown for as long as the filter applies */}
                {selectedUploader ? (
                  <ActiveFilterPill
                    label={`Uploader: ${selectedUploader.name}`}
                    onClear={() => setSelectedUploader(undefined)}
                  />
                ) : null}
              </View>
            }
            ListEmptyComponent={
              (albumQuery.isError && !albumQuery.data) ||
              (scheduleQuery.isError && !scheduleQuery.data) ? (
                <AlbumLoadFailed retrying={pulling} onRetry={() => void refresh()} />
              ) : albumQuery.isPending || scheduleQuery.isPending ? (
                <View className="py-20 items-center justify-center">
                  <ActivityIndicator className="text-textSecondary" />
                </View>
              ) : selectedUploader ? (
                <UploaderEmpty uploaderName={selectedUploader.name} />
              ) : selectedSubEvent ? (
                <SubEventEmpty subEventName={selectedSubEvent.name} />
              ) : (
                <AllEmpty />
              )
            }
          />
        )}
      />

      {/* Filter / Uploader sheet */}
      <UploaderSheet
        eventId={eventId}
        isOpen={filterSheetOpen}
        selectedUploaderId={selectedUploaderId}
        onSelect={setSelectedUploader}
        onClose={() => setFilterSheetOpen(false)}
      />

      {/* More sub-events sheet */}
      <MoreSubEventsSheet
        eventId={eventId}
        subEvents={subEvents}
        albumCounts={selectedSubEventId === null && albumQuery.data ? sectionCountsMap : null}
        uploaderId={selectedUploaderId}
        now={now}
        selectedId={selectedSubEventId}
        liveSubEventId={liveSubEvent?.id ?? null}
        isOpen={moreSheetOpen}
        onSelect={setSelectedSubEventId}
        onClose={() => setMoreSheetOpen(false)}
      />
    </>
  );
}
