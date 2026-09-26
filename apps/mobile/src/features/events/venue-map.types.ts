export interface LatLng {
  lat: number;
  lng: number;
}

export interface VenueMapProps {
  // The venue's point, or null before one is chosen.
  point: LatLng | null;
  // The sub-event's radius, drawn around the point so the Admin sees what the GPS check covers.
  radiusM: number;
  // A point the user tapped or dragged the pin to.
  onPick: (point: LatLng) => void;
}

// Whether this platform draws the map, so the picker knows to explain the placeholder.
export type MapAvailability = 'map' | 'placeholder';
