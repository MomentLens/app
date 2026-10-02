import type { EventSummary, MembershipRole } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { Row } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { formatEventDates, formatStartsIn } from '@/features/events/format';
import { useTokenColor } from '@/hooks/use-token-color';
import { presignedSource } from '@/lib/images';

export const ROLE_LABEL: Record<MembershipRole, string> = {
  admin: 'Admin',
  photographer: 'Photographer',
  guest: 'Guest',
};

// The caller's role, neutral rather than gold, which marks the brand and the main action only
// (D-124). Over a cover it sits on a dark shade.
export function RoleBadge({ role, onPhoto = false }: { role: MembershipRole; onPhoto?: boolean }) {
  return (
    <View className={`rounded-full px-2.5 py-1 ${onPhoto ? 'bg-scrim/45' : 'bg-textPrimary/10'}`}>
      <Text className={`font-micro text-micro ${onPhoto ? 'text-onPhoto' : 'text-textPrimary'}`}>
        {ROLE_LABEL[role]}
      </Text>
    </View>
  );
}

// A cover, or the aperture mark on a muted square until the event has one.
export function CoverThumb({ event, size }: { event: EventSummary; size: number }) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size * 0.23 }}
      className="items-center justify-center overflow-hidden bg-surfaceMuted">
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

// The dark fade under the text at a cover's foot, so white text reads on any photo.
function PhotoShade() {
  const scrim = useTokenColor('scrim');
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 1 1">
      <Defs>
        <LinearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0.3" stopColor={scrim} stopOpacity={0} />
          <Stop offset="1" stopColor={scrim} stopOpacity={0.65} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="1" height="1" fill="url(#shade)" />
    </Svg>
  );
}

interface CoverCardProps {
  event: EventSummary;
  // Happening now: a taller card with a Live badge.
  live?: boolean;
  now: Date;
  onPress: () => void;
}

// An event in Happening now or Upcoming: its cover the width of the list, the name in Fraunces
// over it, its dates, and how far off it is (D-126). Without a cover, the mark on a muted card.
export function CoverCard({ event, live = false, now, onPress }: CoverCardProps) {
  const ripple = useTokenColor('onPhoto', 0.2);
  const dates = formatEventDates(new Date(event.startsAt), new Date(event.endsAt));
  const line = live ? dates : `${dates} · ${formatStartsIn(new Date(event.startsAt), now)}`;
  const photo = event.cover !== null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${event.name}, ${live ? 'happening now, ' : ''}${line}, ${ROLE_LABEL[event.role]}`}
      onPress={onPress}
      android_ripple={{ color: ripple, foreground: true }}
      style={{ height: live ? 240 : 196 }}
      className="overflow-hidden bg-surfaceMuted ios:rounded-[26px] ios:active:opacity-90 android:rounded-3xl">
      {event.cover ? (
        <>
          <Image
            source={presignedSource(event.cover)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            accessibilityIgnoresInvertColors
          />
          <PhotoShade />
        </>
      ) : (
        <View className="absolute inset-0 items-center justify-center pb-10">
          <Icon name="aperture" size={56} className="text-textMuted/50" />
        </View>
      )}
      <View className="absolute left-3.5 right-3.5 top-3.5 flex-row">
        {live ? (
          <View
            className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1 ${photo ? 'bg-scrim/45' : 'bg-textPrimary/10'}`}>
            <View className="h-2 w-2 rounded-full bg-danger" />
            <Text
              className={`font-micro text-micro ${photo ? 'text-onPhoto' : 'text-textPrimary'}`}>
              Live
            </Text>
          </View>
        ) : (
          <RoleBadge role={event.role} onPhoto={photo} />
        )}
      </View>
      <View className="absolute bottom-0 left-0 right-0 gap-1 p-4">
        <Text
          numberOfLines={2}
          className={`font-h1 text-h1 ${photo ? 'text-onPhoto' : 'text-textPrimary'}`}>
          {event.name}
        </Text>
        <Text
          className={`font-bodySecondary text-bodySecondary ${photo ? 'text-onPhoto/90' : 'text-textSecondary'}`}>
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

// A Past event: a compact row with a small cover (D-126).
export function PastEventRow({ event, onPress }: { event: EventSummary; onPress: () => void }) {
  const dates = formatEventDates(new Date(event.startsAt), new Date(event.endsAt));
  return (
    <Row
      leading={<CoverThumb event={event} size={44} />}
      leadingWidth={44}
      title={event.name}
      subtitle={dates}
      chevron
      onPress={onPress}
      accessibilityLabel={`${event.name}, ${dates}, ${ROLE_LABEL[event.role]}`}
    />
  );
}
