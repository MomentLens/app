import type { SubEvent } from '@momentlens/shared-types';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Sheet } from '@/components/ui/sheet';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { formatDay } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';

interface MoreSubEventsSheetProps {
  subEvents: readonly SubEvent[];
  sectionCounts: Readonly<Record<string, number>>;
  totalCount: number;
  selectedId: string | null;
  liveSubEventId: string | null;
  isOpen: boolean;
  onSelect: (subEventId: string | null) => void;
  onClose: () => void;
}

// Sub-events sheet (spec §2.5.2, D-148):
// Shown when an event has more than 6 sub-events and the user taps "More ▾" in the chip row.
export function MoreSubEventsSheet({
  subEvents,
  sectionCounts,
  totalCount,
  selectedId,
  liveSubEventId,
  isOpen,
  onSelect,
  onClose,
}: MoreSubEventsSheetProps) {
  return (
    <Sheet target={isOpen ? true : null} onClose={onClose}>
      {() => (
        <View className="flex-1 bg-background">
          <SheetHandle />
          <SheetToolbar title="Sub-Events" onClose={onClose} />

          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
            <View className="overflow-hidden rounded-2xl border border-border bg-surface">
              {/* All sub-events row */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`All sub-events, ${totalCount} photos`}
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
                  <Text className="font-caption text-caption text-textSecondary">
                    {totalCount} photos
                  </Text>
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
                const count = sectionCounts[subEvent.id];

                return (
                  <Pressable
                    key={subEvent.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${subEvent.name}, ${count !== undefined ? `${count} photos` : 'Not started'}`}
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
                          {formatDay(new Date(subEvent.startsAt))} ·{' '}
                          {count !== undefined ? `${count} photos` : 'Not started'}
                        </Text>
                      </View>
                    </View>
                    {isSelected ? (
                      <Text className="font-body font-bold text-accentText">✓</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      )}
    </Sheet>
  );
}
