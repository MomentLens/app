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
  // The height of what floats over the map's foot, so the map's logo and legal link sit above it
  // and a chosen point centres in the part left showing.
  bottomInset?: number;
}

// Whether this platform draws the map, so the picker knows to explain the placeholder.
export type MapAvailability = 'map' | 'placeholder';
