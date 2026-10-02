import type { SubEvent } from '@momentlens/shared-types';
import { Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { formatTimeRange } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';
import { useTokenColor } from '@/hooks/use-token-color';
import { byPlatform } from '@/lib/copy';

interface LiveCardProps {
  subEvent: SubEvent;
  number: number;
  onOpen: () => void;
  // "View photos", which opens Home on this sub-event. Left out for a Photographer (spec §4.10).
  onViewPhotos?: () => void;
  // The Admin's Delay, on the sub-event most likely to run late (D-127).
  onDelay?: () => void;
}

// The sub-event In Progress, above the Schedule. When several overlap it is the one capture tags
// to, the most recently started (spec §4.3). It takes the hero tokens: ink on the cream page in
// light mode, a raised warm surface in dark, rather than swapping text and background, which made
// a cream slab in dark mode (D-124). "Live now" is the one uppercase label in the app.
export function LiveCard({ subEvent, number, onOpen, onViewPhotos, onDelay }: LiveCardProps) {
  const ripple = useTokenColor('onHero', 0.16);
  const times = formatTimeRange(new Date(subEvent.startsAt), new Date(subEvent.endsAt));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Live now, ${subEvent.name}, ${times}, ${subEvent.venue.name}`}
      accessibilityHint="Opens the sub-event"
      onPress={onOpen}
      android_ripple={{ color: ripple, foreground: true }}
      className="gap-2.5 overflow-hidden bg-hero p-5 ios:mx-5 ios:rounded-[26px] ios:active:opacity-90 android:mx-4 android:rounded-3xl">
      <View className="flex-row items-center gap-2">
        <View className="h-2 w-2 rounded-full bg-danger" />
        <Text className="font-micro text-micro uppercase tracking-widest text-onHero">
          Live now
        </Text>
      </View>
      <View className="flex-row items-baseline gap-2">
        <Text className="font-fraunces-semibold text-h2 text-onHero/70">
          {romanNumeral(number)}
        </Text>
        <Text numberOfLines={2} className="flex-1 font-h1 text-h1 text-onHero">
          {subEvent.name}
        </Text>
      </View>
      <Text className="font-bodySecondary text-bodySecondary text-onHero/75">
        {times} · {subEvent.venue.name}
      </Text>
      {onViewPhotos || onDelay ? (
        <View className="flex-row gap-2.5 pt-1">
          {onViewPhotos ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View photos from ${subEvent.name}`}
              onPress={onViewPhotos}
              android_ripple={{ color: ripple }}
              className="flex-1 items-center justify-center overflow-hidden rounded-full bg-onHero/15 ios:min-h-9 ios:active:opacity-80 android:min-h-10">
              <Text className="font-buttonLabel text-bodySecondary text-onHero">
                {byPlatform('View Photos', 'View photos')}
              </Text>
            </Pressable>
          ) : null}
          {onDelay ? (
            <View className="flex-1">
              <Button label="Delay" icon="clock" size="small" onPress={onDelay} />
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
