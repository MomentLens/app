import type { SubEvent } from '@momentlens/shared-types';
import { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Sheet } from '@/components/ui/sheet';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { formatDay } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';
import { useSectionCounts } from './use-album';

interface MoreSubEventsSheetProps {
  eventId: string;
  subEvents: readonly SubEvent[];
  // The album's own counts when no chip is active. With a chip active they cover only that
  // sub-event, so pass null and the sheet reads every section's count itself.
  albumCounts: Readonly<Record<string, number>> | null;
  uploaderId: string | undefined;
  now: Date;
  selectedId: string | null;
  liveSubEventId: string | null;
  isOpen: boolean;
  onSelect: (subEventId: string | null) => void;
  onClose: () => void;
}

// Sub-events sheet (spec §2.5.2, D-148):
// Shown when an event has more than 6 sub-events and the user taps "More ▾" in the chip row.
// Counts follow the uploader filter, never the chip, so each row says what picking it shows.
export function MoreSubEventsSheet({ isOpen, onClose, ...props }: MoreSubEventsSheetProps) {
  return (
    <Sheet target={isOpen ? true : null} onClose={onClose}>
      {() => <MoreSubEventsContent {...props} onClose={onClose} />}
    </Sheet>
  );
}

function MoreSubEventsContent({
  eventId,
  subEvents,
  albumCounts,
  uploaderId,
  now,
  selectedId,
  liveSubEventId,
  onSelect,
  onClose,
}: Omit<MoreSubEventsSheetProps, 'isOpen'>) {
  const fetched = useSectionCounts(eventId, uploaderId, albumCounts === null);
  const counts = useMemo(() => {
    if (albumCounts !== null) return albumCounts;
    return Object.fromEntries(
      (fetched.data ?? []).map((section) => [section.subEventId, section.count]),
    );
  }, [albumCounts, fetched.data]);
  const known = albumCounts !== null || fetched.isSuccess;
  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const photos = (n: number) => `${n} ${n === 1 ? 'photo' : 'photos'}`;
  // A sub-event that has started shows its count, 0 included. One still ahead reads "Not started"
  // unless a Delay moved it after photos were filed under it.
  const detail = (subEvent: SubEvent) => {
    const count = counts[subEvent.id] ?? 0;
    if (known && count > 0) return photos(count);
    if (Date.parse(subEvent.startsAt) > now.getTime()) return 'Not started';
    return known ? photos(0) : null;
  };

  return (
    <View className="flex-1 bg-background">
      <SheetHandle />
      <SheetToolbar title="Sub-Events" onClose={onClose} />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <View className="overflow-hidden rounded-2xl border border-border bg-surface">
          {/* All sub-events row */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={known ? `All sub-events, ${photos(totalCount)}` : 'All sub-events'}
            onPress={() => {
              onSelect(null);
              onClose();
            }}
            className={`flex-row items-center justify-between border-b border-border p-4 ${
              selectedId === null ? 'bg-surfaceElevated' : ''
            }`}>
            <View className="gap-0.5">
              <Text className="font-h2 text-body font-semibold text-textPrimary">
                All Sub-Events
              </Text>
              {known ? (
                <Text className="font-caption text-caption text-textSecondary">
                  {photos(totalCount)}
                </Text>
              ) : null}
            </View>
            {selectedId === null ? (
              <Text className="font-body font-bold text-accentText">✓</Text>
            ) : null}
          </Pressable>

          {/* Individual sub-event rows */}
          {subEvents.map((subEvent, index) => {
            const isSelected = selectedId === subEvent.id;
            const isLive = liveSubEventId === subEvent.id;
            const isLast = index === subEvents.length - 1;
            const status = detail(subEvent);

            return (
              <Pressable
                key={subEvent.id}
                accessibilityRole="button"
                accessibilityLabel={status ? `${subEvent.name}, ${status}` : subEvent.name}
                onPress={() => {
                  onSelect(subEvent.id);
                  onClose();
                }}
                className={`flex-row items-center justify-between p-4 ${
                  !isLast ? 'border-b border-border' : ''
                } ${isSelected ? 'bg-surfaceElevated' : ''}`}>
                <View className="flex-row items-center gap-3">
                  <Text className="w-8 font-serif text-lg font-bold text-accentText">
                    {romanNumeral(index + 1)}
                  </Text>
                  <View className="gap-0.5">
                    <View className="flex-row items-center gap-1.5">
                      <Text className="font-h2 text-body font-semibold text-textPrimary">
                        {subEvent.name}
                      </Text>
                      {isLive ? (
                        <View
                          accessibilityLabel="Live"
                          className="h-2 w-2 rounded-full bg-danger"
                        />
                      ) : null}
                    </View>
                    <Text className="font-caption text-caption text-textSecondary">
                      {formatDay(new Date(subEvent.startsAt))}
                      {status ? ` · ${status}` : ''}
                    </Text>
                  </View>
                </View>
                {isSelected ? <Text className="font-body font-bold text-accentText">✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
