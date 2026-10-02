import { Text, View } from 'react-native';

import { Row } from '@/components/ui/grouped';
import type { DraftSubEvent } from '@/features/events/draft';
import { formatDay, formatRadius, formatTime } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';

interface DraftSubEventRowProps {
  subEvent: DraftSubEvent;
  number: number;
  // Reopens the sheet on this sub-event (D-111). Left out while the wizard is locked.
  onPress?: () => void;
}

// One sub-event in the wizard's step 2 and review, as the Schedule draws one (D-127): its day and
// times in a column, the numeral before the name, and the venue with its radius.
export function DraftSubEventRow({ subEvent, number, onPress }: DraftSubEventRowProps) {
  const day = formatDay(subEvent.startsAt);
  const times = `${formatTime(subEvent.startsAt)} – ${formatTime(subEvent.endsAt)}`;
  return (
    <Row
      chevron={onPress !== undefined}
      onPress={onPress}
      accessibilityLabel={`${subEvent.name}, ${day}, ${times}, ${subEvent.venue.name}`}
      accessibilityHint={onPress ? 'Edits the sub-event' : undefined}>
      <View className="flex-row items-start gap-3.5">
        <View className="w-[76px]">
          <Text numberOfLines={1} className="font-fieldLabel text-bodySecondary text-textPrimary">
            {day}
          </Text>
          <Text
            numberOfLines={1}
            className="font-caption text-caption tabular-nums text-textSecondary">
            {formatTime(subEvent.startsAt)}
          </Text>
        </View>
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-baseline gap-1.5">
            <Text className="font-fraunces-semibold text-body text-accentText">
              {romanNumeral(number)}
            </Text>
            <Text numberOfLines={1} className="flex-1 font-h2 text-body text-textPrimary">
              {subEvent.name}
            </Text>
          </View>
          <Text
            numberOfLines={1}
            className="font-bodySecondary text-bodySecondary text-textSecondary">
            {subEvent.venue.name} · {formatRadius(subEvent.radiusM)}
          </Text>
        </View>
      </View>
    </Row>
  );
}
