import type { SubEvent } from '@momentlens/shared-types';
import { Pressable, Text, View } from 'react-native';

import { formatTimeRange } from '@/features/events/format';

interface LiveCardProps {
  subEvent: SubEvent;
  onOpen: () => void;
  // "View photos", which opens Home on this sub-event. Left out for a Photographer (spec §4.10).
  onViewPhotos?: () => void;
}

// The sub-event In Progress now, at the top of the Schedule, as the Figma Schedule frame draws it.
// When several overlap it is the one capture tags to, the most recently started (spec §4.3). The
// card inverts the page's colors in both modes: textPrimary behind, background as the text.
export function LiveCard({ subEvent, onOpen, onViewPhotos }: LiveCardProps) {
  const times = formatTimeRange(new Date(subEvent.startsAt), new Date(subEvent.endsAt));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Live now, ${subEvent.name}, ${times}, ${subEvent.venue.name}`}
      accessibilityHint="Opens the sub-event"
      onPress={onOpen}
      className="gap-3 rounded-2xl bg-textPrimary p-5 active:opacity-90">
      <Text className="font-micro text-micro uppercase tracking-widest text-background/70">
        Live now
      </Text>
      <Text numberOfLines={2} className="font-h1 text-h1 text-background">
        {subEvent.name}
      </Text>
      <View className="flex-row items-center justify-between gap-3">
        <Text
          numberOfLines={2}
          className="flex-1 font-micro text-micro uppercase tracking-wider text-background/70">
          {times} · {subEvent.venue.name}
        </Text>
        {onViewPhotos ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View photos from ${subEvent.name}`}
            hitSlop={8}
            onPress={onViewPhotos}
            className="min-h-11 justify-center rounded-full bg-background px-4 active:opacity-80">
            <Text className="font-micro text-micro uppercase tracking-wider text-textPrimary">
              View photos
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}
