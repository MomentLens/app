import type { MapAvailability, VenueMapProps } from '@/features/events/venue-map.types';

export const MAP_AVAILABILITY: MapAvailability = 'placeholder';

// Android's venue map is Google Maps, which throws without the key this build does not have yet
// (D-110). Until the key and its native rebuild land, the picker lists search results and the
// phone's own position and draws no map at all, rather than a box saying it is missing (D-128).
export function VenueMap(_props: VenueMapProps) {
  return null;
}
