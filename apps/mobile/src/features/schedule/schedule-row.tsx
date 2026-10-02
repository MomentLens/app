import type { SubEvent, SubEventStatus } from '@momentlens/shared-types';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { formatTime } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';

export const STATUS_LABEL: Record<SubEventStatus, string> = {
  upcoming: 'Upcoming',
  in_progress: 'In progress',
  completed: 'Completed',
};

interface ScheduleRowProps {
  subEvent: SubEvent;
  number: number;
  status: SubEventStatus;
  first: boolean;
  onOpen: () => void;
  // The Admin's inline Delay (spec §2.5.5). Left out for every other role.
  onDelay?: () => void;
}

// One sub-event in the Schedule, as the Figma Schedule frame draws it: the start, its numeral, its
// name and venue. A finished one is dimmed with a check and a running one carries a Live badge, so
// each row shows its status (spec §2.5.5). Every row opens Sub-event Detail.
export function ScheduleRow({
  subEvent,
  number,
  status,
  first,
  onOpen,
  onDelay,
}: ScheduleRowProps) {
  const done = status === 'completed';
  const startsAt = formatTime(new Date(subEvent.startsAt));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${subEvent.name}, ${STATUS_LABEL[status]}, ${startsAt}, ${subEvent.venue.name}`}
      accessibilityHint="Opens the sub-event"
      onPress={onOpen}
      className={`min-h-16 flex-row items-center gap-3 px-4 py-3 active:bg-surfaceMuted ${first ? '' : 'border-t border-border'}`}>
      <Text
        className={`w-16 font-caption text-caption ${done ? 'text-textMuted' : 'text-textSecondary'}`}>
        {startsAt}
      </Text>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text
            className={`font-fraunces-semibold text-bodySecondary ${done ? 'text-textMuted' : 'text-accentText'}`}>
            {romanNumeral(number)}
          </Text>
          <Text
            numberOfLines={1}
            className={`flex-1 font-semibold text-body ${done ? 'text-textMuted' : 'text-textPrimary'}`}>
            {subEvent.name}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          className="font-micro text-micro uppercase tracking-wider text-textSecondary">
          {subEvent.venue.name}
        </Text>
      </View>
      {status === 'in_progress' ? (
        <View className="rounded-full bg-accentTint px-2 py-0.5">
          <Text className="font-micro text-micro uppercase text-accentText">Live</Text>
        </View>
      ) : null}
      {onDelay ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delay ${subEvent.name}`}
          hitSlop={8}
          onPress={onDelay}
          className="min-h-9 justify-center rounded-full border border-borderStrong px-3 active:bg-surfaceMuted">
          <Text className="font-micro text-micro text-textPrimary">Delay</Text>
        </Pressable>
      ) : null}
      <Icon
        name={done ? 'check' : 'chevron-right'}
        size={16}
        className={done ? 'text-textMuted' : 'text-textSecondary'}
      />
    </Pressable>
  );
}
