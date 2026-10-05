import type { EventSummary, SubEvent } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { GLYPH, Glyph } from '@/components/ui/glyph';
import { formatDay, formatSubEventTimes } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';
import { presignedSource } from '@/lib/images';

interface PreEventViewProps {
  event: EventSummary;
  subEvents: readonly SubEvent[];
  now: Date;
}

function countdownText(startsAt: string, now: Date): string {
  const start = new Date(startsAt).getTime();
  const current = now.getTime();
  const diffMs = start - current;

  if (diffMs <= 0) return 'Starts today';
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (days === 1) return 'Starts tomorrow';
  if (days > 1) return `${days} days to go`;

  const hours = Math.ceil(diffMs / (1000 * 60 * 60));
  return `Starts in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

// Pre-event state (spec §2.5.2, D-138, D-148):
// Shown until the first sub-event starts. Features full-width cover card with countdown and
// first sub-event time, followed by the inline schedule.
export function PreEventView({ event, subEvents, now }: PreEventViewProps) {
  const router = useRouter();
  const firstSubEvent = subEvents[0];
  const countdown = firstSubEvent ? countdownText(firstSubEvent.startsAt, now) : null;

  return (
    <View className="gap-6 px-4 pb-8">
      {/* Cover Card with Countdown */}
      <View className="relative h-64 w-full overflow-hidden rounded-2xl bg-surfaceElevated">
        {event.cover ? (
          <Image
            source={presignedSource(event.cover)}
            contentFit="cover"
            className="h-full w-full"
          />
        ) : (
          <View className="h-full w-full bg-surfaceElevated" />
        )}
        {/* Dark gradient overlay for text readability */}
        <View className="absolute inset-0 justify-end bg-black/40 p-5">
          {countdown ? (
            <Text className="font-serif text-3xl font-bold text-white">{countdown}</Text>
          ) : null}
          {firstSubEvent ? (
            <Text className="mt-1 font-body text-body text-white/90">
              {firstSubEvent.name} · {formatDay(new Date(firstSubEvent.startsAt))}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Schedule list */}
      <View className="gap-2">
        <Text accessibilityRole="header" className="font-h2 text-h2 text-accentText">
          Schedule
        </Text>
        <View className="overflow-hidden rounded-2xl border border-border bg-surface">
          {subEvents.map((subEvent, index) => {
            const isLast = index === subEvents.length - 1;
            return (
              <Pressable
                key={subEvent.id}
                accessibilityRole="button"
                accessibilityLabel={`${subEvent.name}, ${formatSubEventTimes(
                  new Date(subEvent.startsAt),
                  new Date(subEvent.endsAt),
                )}`}
                onPress={() =>
                  router.push({
                    pathname: '/sub-event/[eventId]/[subEventId]',
                    params: { eventId: event.id, subEventId: subEvent.id },
                  })
                }
                className={`flex-row items-center justify-between p-4 ${
                  !isLast ? 'border-b border-border' : ''
                }`}>
                <View className="mr-3 flex-1 flex-row items-start gap-3">
                  <Text className="font-serif text-lg font-bold text-accentText">
                    {romanNumeral(index + 1)}
                  </Text>
                  <View className="flex-1 gap-0.5">
                    <Text className="font-h2 text-body font-semibold text-textPrimary">
                      {subEvent.name}
                    </Text>
                    <Text className="font-caption text-caption text-textSecondary">
                      {formatDay(new Date(subEvent.startsAt))} ·{' '}
                      {formatSubEventTimes(new Date(subEvent.startsAt), new Date(subEvent.endsAt))}{' '}
                      · {subEvent.venue.name}
                    </Text>
                  </View>
                </View>
                <Glyph name={GLYPH.chevron} size={16} tone="textSecondary" />
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
