import type { SubEvent } from '@momentlens/shared-types';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

const IOS = Platform.OS === 'ios';
const MAX_INLINE_CHIPS = 6;

interface SubEventChipsProps {
  subEvents: readonly SubEvent[];
  selectedId: string | null;
  liveSubEventId: string | null;
  onSelect: (subEventId: string | null) => void;
  onOpenMore?: () => void;
}

// Sub-event chip row, directly under the header (spec §2.5.2, D-148).
// "All" by default. Shows each sub-event in schedule order with a live red dot when in progress.
// Past 6 sub-events, a "More" chip opens a sheet listing them all (D-148).
// Scrolls to the in-progress sub-event on mount, focus, and foreground (D-148).
// iOS: rounded capsules. Android: Material 3 bordered chips with checkmark on active.
export function SubEventChips({
  subEvents,
  selectedId,
  liveSubEventId,
  onSelect,
  onOpenMore,
}: SubEventChipsProps) {
  const scrollRef = useRef<ScrollView>(null);
  const chipPositions = useRef<Record<string, number>>({});

  const scrollToLive = useCallback(() => {
    if (!liveSubEventId) return;
    const x = chipPositions.current[liveSubEventId];
    if (x !== undefined && x > 0) {
      scrollRef.current?.scrollTo({ x: Math.max(0, x - 20), animated: true });
    }
  }, [liveSubEventId]);

  // Scroll to live chip on focus
  useFocusEffect(
    useCallback(() => {
      // Small timeout to allow layout to settle
      const timer = setTimeout(scrollToLive, 100);
      return () => clearTimeout(timer);
    }, [scrollToLive]),
  );

  // Scroll to live chip on app foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        scrollToLive();
      }
    });
    return () => subscription.remove();
  }, [scrollToLive]);

  const recordLayout = (id: string, event: LayoutChangeEvent) => {
    chipPositions.current[id] = event.nativeEvent.layout.x;
  };

  const inlineSubEvents = subEvents.slice(0, MAX_INLINE_CHIPS);
  const hasMore = subEvents.length > MAX_INLINE_CHIPS;

  const isAllSelected = selectedId === null;

  return (
    <View className="py-2.5">
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: IOS ? 16 : 16, gap: 8 }}>
        {/* "All" chip */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="All sub-events"
          onLayout={(e) => recordLayout('all', e)}
          onPress={() => onSelect(null)}
          className={
            IOS
              ? `flex-row items-center rounded-full px-4 py-2 ${
                  isAllSelected ? 'bg-textPrimary' : 'bg-surfaceElevated'
                }`
              : `flex-row items-center rounded-lg border px-3.5 py-1.5 ${
                  isAllSelected ? 'border-accent bg-accent/20' : 'border-border bg-surface'
                }`
          }>
          {!IOS && isAllSelected ? (
            <Text className="mr-1.5 font-body text-body text-accentText">✓</Text>
          ) : null}
          <Text
            className={
              IOS
                ? `font-body text-body ${isAllSelected ? 'text-background' : 'text-textPrimary'}`
                : `font-body text-body ${isAllSelected ? 'text-accentText' : 'text-textPrimary'}`
            }>
            All
          </Text>
        </Pressable>

        {/* Inline sub-event chips */}
        {inlineSubEvents.map((subEvent) => {
          const isSelected = selectedId === subEvent.id;
          const isLive = liveSubEventId === subEvent.id;

          return (
            <Pressable
              key={subEvent.id}
              accessibilityRole="button"
              accessibilityLabel={`${subEvent.name}${isLive ? ', In Progress' : ''}`}
              onLayout={(e) => recordLayout(subEvent.id, e)}
              onPress={() => onSelect(subEvent.id)}
              className={
                IOS
                  ? `flex-row items-center rounded-full px-4 py-2 ${
                      isSelected ? 'bg-textPrimary' : 'bg-surfaceElevated'
                    }`
                  : `flex-row items-center rounded-lg border px-3.5 py-1.5 ${
                      isSelected ? 'border-accent bg-accent/20' : 'border-border bg-surface'
                    }`
              }>
              {!IOS && isSelected ? (
                <Text className="mr-1.5 font-body text-body text-accentText">✓</Text>
              ) : null}
              {isLive ? (
                <View accessibilityLabel="Live" className="mr-1.5 h-2 w-2 rounded-full bg-danger" />
              ) : null}
              <Text
                numberOfLines={1}
                className={
                  IOS
                    ? `font-body text-body ${isSelected ? 'text-background' : 'text-textPrimary'}`
                    : `font-body text-body ${isSelected ? 'text-accentText' : 'text-textPrimary'}`
                }>
                {subEvent.name}
              </Text>
            </Pressable>
          );
        })}

        {/* "More" chip if more than 6 sub-events */}
        {hasMore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More sub-events"
            onPress={onOpenMore}
            className={
              IOS
                ? 'flex-row items-center rounded-full bg-surfaceElevated px-4 py-2'
                : 'flex-row items-center rounded-lg border border-border bg-surface px-3.5 py-1.5'
            }>
            <Text className="font-body text-body text-textPrimary">More ▾</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
