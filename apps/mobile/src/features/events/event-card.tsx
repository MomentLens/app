import type { EventSummary, MembershipRole } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { formatEventDates } from '@/features/events/format';
import { presignedSource } from '@/lib/images';

export const ROLE_LABEL: Record<MembershipRole, string> = {
  admin: 'Admin',
  photographer: 'Photographer',
  guest: 'Guest',
};

export function RoleBadge({ role }: { role: MembershipRole }) {
  return (
    <View className="rounded-full bg-accentTint px-2 py-0.5">
      <Text className="font-micro text-micro text-accentText">{ROLE_LABEL[role]}</Text>
    </View>
  );
}

// A cover, or the aperture mark on a muted square until the event has one.
export function CoverThumb({ event, size }: { event: EventSummary; size: number }) {
  return (
    <View
      style={{ width: size, height: size }}
      className="items-center justify-center overflow-hidden rounded-xl bg-surfaceMuted">
      {event.cover ? (
        <Image
          source={presignedSource(event.cover)}
          style={{ width: size, height: size }}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon name="aperture" size={size / 2.5} className="text-textMuted" />
      )}
    </View>
  );
}

interface EventCardProps {
  event: EventSummary;
  onPress: () => void;
}

// One event in the Events tab: its cover, name, span and the caller's own role.
export function EventCard({ event, onPress }: EventCardProps) {
  const dates = formatEventDates(new Date(event.startsAt), new Date(event.endsAt));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${event.name}, ${dates}, ${ROLE_LABEL[event.role]}`}
      onPress={onPress}
      className="flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-3 active:bg-surfaceMuted">
      <CoverThumb event={event} size={56} />
      <View className="flex-1 gap-1">
        <Text numberOfLines={2} className="font-fraunces-semibold text-h2 text-textPrimary">
          {event.name}
        </Text>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="font-caption text-caption text-textSecondary">{dates}</Text>
          <RoleBadge role={event.role} />
        </View>
      </View>
    </Pressable>
  );
}
