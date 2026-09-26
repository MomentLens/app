import { Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import type { MapAvailability, VenueMapProps } from '@/features/events/venue-map.types';

export const MAP_AVAILABILITY: MapAvailability = 'placeholder';

// Android's venue map is Google Maps, which throws without the key this build does not have yet,
// so a placeholder stands in until the key and its native rebuild land (S-02 card, D-110). A
// venue comes from a search result or the phone's own position meanwhile.
export function VenueMap({ point }: VenueMapProps) {
  return (
    <View className="h-40 items-center justify-center gap-2 rounded-xl border border-dashed border-borderStrong bg-surfaceMuted px-6">
      <Icon name="map-pin" size={22} className="text-textSecondary" />
      <Text className="text-center font-caption text-caption text-textSecondary">
        {point
          ? `Venue set at ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}.`
          : 'The map is not in this build yet. Search for the venue, or use your current location.'}
      </Text>
    </View>
  );
}
