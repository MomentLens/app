import { Pressable, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import type { DraftSubEvent } from '@/features/events/draft';
import { formatRadius, formatSubEventTimes } from '@/features/events/format';

function Line({ icon, text }: { icon: IconName; text: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <Icon name={icon} size={14} className="text-accent" />
      <Text className="flex-1 font-caption text-caption text-textSecondary">{text}</Text>
    </View>
  );
}

interface SubEventCardProps {
  subEvent: DraftSubEvent;
  // The pencil, which reopens the sheet on this sub-event (D-111).
  onEdit: () => void;
}

// One sub-event in the wizard: its name, times, venue and radius, as in the Figma step 2 and
// review frames.
export function SubEventCard({ subEvent, onEdit }: SubEventCardProps) {
  return (
    <View className="gap-2 rounded-xl border border-border bg-surface p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text numberOfLines={2} className="flex-1 font-fieldLabel text-fieldLabel text-textPrimary">
          {subEvent.name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${subEvent.name}`}
          hitSlop={12}
          onPress={onEdit}>
          <Icon name="pencil" size={16} className="text-textSecondary" />
        </Pressable>
      </View>
      <Line icon="clock" text={formatSubEventTimes(subEvent.startsAt, subEvent.endsAt)} />
      <Line icon="map-pin" text={subEvent.venue.name} />
      <Line icon="circle-dot" text={`${formatRadius(subEvent.radiusM)} verification radius`} />
    </View>
  );
}
