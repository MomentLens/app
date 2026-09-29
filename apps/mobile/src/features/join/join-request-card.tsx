import type { JoinRequest } from '@momentlens/shared-types';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { ROLE_LABEL } from '@/features/events/event-card';

interface JoinRequestCardProps {
  request: JoinRequest;
  onPress: () => void;
}

// One of the caller's own join requests on the Events tab, which opens Pending Approval (D-115).
// Laid out as an event card, with a clock where the cover goes: the cover is not shown before
// the Admin lets them in.
export function JoinRequestCard({ request, onPress }: JoinRequestCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${request.eventName}, waiting for approval as ${ROLE_LABEL[request.role]}`}
      onPress={onPress}
      className="flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-3 active:bg-surfaceMuted">
      <View className="h-14 w-14 items-center justify-center rounded-xl bg-accentTint">
        <Icon name="clock" size={24} className="text-accent" />
      </View>
      <View className="flex-1 gap-1">
        <Text numberOfLines={2} className="font-fraunces-semibold text-h2 text-textPrimary">
          {request.eventName}
        </Text>
        <Text className="font-caption text-caption text-accentText">
          Waiting for approval · {ROLE_LABEL[request.role]}
        </Text>
      </View>
    </Pressable>
  );
}
