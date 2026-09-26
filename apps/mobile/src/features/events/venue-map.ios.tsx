import { cssInterop } from 'nativewind';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';

import type { MapAvailability, VenueMapProps } from '@/features/events/venue-map.types';

export const MAP_AVAILABILITY: MapAvailability = 'map';

// Circle takes its colors as props. This moves a text-* token's color onto the outline and a bg-*
// token's onto the fill, as icon.tsx does for an Svg, so no hex reaches a component.
const TokenCircle = cssInterop(Circle, {
  className: {
    target: false,
    nativeStyleToProp: { color: 'strokeColor', backgroundColor: 'fillColor' },
  },
});

const METRES_PER_DEGREE = 111_000;

function regionAround(lat: number, lng: number, radiusM: number) {
  // Room for the whole circle with a margin on each side.
  const delta = Math.max((radiusM * 3) / METRES_PER_DEGREE, 0.004);
  return { latitude: lat, longitude: lng, latitudeDelta: delta, longitudeDelta: delta };
}

// The venue on Apple Maps, which needs no key (D-110). Tap the map or drag the pin to move it.
export function VenueMap({ point, radiusM, onPick }: VenueMapProps) {
  const map = useRef<MapView>(null);

  // Follows a point chosen from a search or the phone's location, without taking the map away
  // from the user's own panning in between.
  useEffect(() => {
    if (point === null) return;
    map.current?.animateToRegion(regionAround(point.lat, point.lng, radiusM), 300);
  }, [point, radiusM]);

  return (
    <View className="h-64 overflow-hidden rounded-xl border border-border">
      <MapView
        ref={map}
        style={{ flex: 1 }}
        initialRegion={point ? regionAround(point.lat, point.lng, radiusM) : undefined}
        onPress={(event) => {
          const { latitude, longitude } = event.nativeEvent.coordinate;
          onPick({ lat: latitude, lng: longitude });
        }}
        accessibilityLabel="Venue map. Tap to place the venue, or drag its pin.">
        {point ? (
          <>
            <TokenCircle
              center={{ latitude: point.lat, longitude: point.lng }}
              radius={radiusM}
              strokeWidth={2}
              className="bg-accent/20 text-accent"
            />
            <Marker
              coordinate={{ latitude: point.lat, longitude: point.lng }}
              draggable
              onDragEnd={(event) => {
                const { latitude, longitude } = event.nativeEvent.coordinate;
                onPick({ lat: latitude, lng: longitude });
              }}
            />
          </>
        ) : null}
      </MapView>
      {point === null ? (
        <View pointerEvents="none" className="absolute inset-x-0 bottom-0 bg-surface/90 px-3 py-2">
          <Text className="text-center font-caption text-caption text-textSecondary">
            Search above, or tap the map to drop a pin.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
