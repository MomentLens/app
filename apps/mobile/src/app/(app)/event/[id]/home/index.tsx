import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, Text, View } from 'react-native';

import { GLYPH } from '@/components/ui/glyph';
import { useEventId } from '@/features/event-shell/event-id';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';
import { tabHref } from '@/features/event-shell/tabs';
import { useEvent } from '@/features/event-shell/use-event';
import { formatEventDates } from '@/features/events/format';
import { ActiveFilterPill } from '@/features/album/active-filter-pill';
import { AlbumGrid } from '@/features/album/album-grid';
import { AllEmpty, SubEventEmpty, UploaderEmpty } from '@/features/album/empty-states';
import { MoreSubEventsSheet } from '@/features/album/more-sub-events-sheet';
import { PreEventView } from '@/features/album/pre-event-view';
import { buildAlbumListItems } from '@/features/album/sections';
import { SubEventChips } from '@/features/album/sub-event-chips';
import { UploaderSheet } from '@/features/album/uploader-sheet';
import { useAlbum, useUploaders } from '@/features/album/use-album';
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

  const nextChange = useCallback((at: Date) => nextStatusChange(subEvents, at), [subEvents]);
  const now = useNow(nextChange);
  const liveSubEvent = currentSubEvent(subEvents, now);

  // Active filters
  const [selectedSubEventId, setSelectedSubEventId] = useState<string | null>(
    initialSubEventId ?? null,
  );
  const [selectedUploaderId, setSelectedUploaderId] = useState<string | undefined>(undefined);

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
  const isPreEvent = useMemo(() => {
    if (subEvents.length === 0) return false;
    const firstStart = Date.parse(subEvents[0]!.startsAt);
    return now.getTime() < firstStart;
  }, [subEvents, now]);

  // Build flattened items for FlashList v2
  const { items, stickyIndices } = useMemo(
    () =>
      buildAlbumListItems(
        allMedia,
        subEvents,
        sectionCountsMap,
        liveSubEvent?.id ?? null,
        selectedSubEventId ?? undefined,
      ),
    [allMedia, subEvents, sectionCountsMap, liveSubEvent?.id, selectedSubEventId],
  );

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

  // Uploader name for active filter pill
  const activeUploaderName = useMemo(() => {
    if (!selectedUploaderId) return undefined;
    const found = uploadersQuery.data?.uploaders.find((u) => u.userId === selectedUploaderId);
    return found?.fullName;
  }, [selectedUploaderId, uploadersQuery.data?.uploaders]);

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
    if (liveSubEvent) {
      return `${liveSubEvent.name} is live · ${totalPhotosCount} photos`;
    }
    return `${totalPhotosCount} ${totalPhotosCount === 1 ? 'photo' : 'photos'}`;
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
            eventId={eventId}
            items={items}
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

                {/* Active uploader filter pill */}
                {activeUploaderName ? (
                  <ActiveFilterPill
                    label={`Uploader: ${activeUploaderName}`}
                    onClear={() => setSelectedUploaderId(undefined)}
                  />
                ) : null}
              </View>
            }
            ListEmptyComponent={
              albumQuery.isPending ? (
                <View className="py-20 items-center justify-center">
                  <ActivityIndicator className="text-textSecondary" />
                </View>
              ) : activeUploaderName ? (
                <UploaderEmpty uploaderName={activeUploaderName} />
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
        onSelect={setSelectedUploaderId}
        onClose={() => setFilterSheetOpen(false)}
      />

      {/* More sub-events sheet */}
      <MoreSubEventsSheet
        subEvents={subEvents}
        sectionCounts={sectionCountsMap}
        totalCount={totalPhotosCount}
        selectedId={selectedSubEventId}
        liveSubEventId={liveSubEvent?.id ?? null}
        isOpen={moreSheetOpen}
        onSelect={setSelectedSubEventId}
        onClose={() => setMoreSheetOpen(false)}
      />
    </>
  );
}
