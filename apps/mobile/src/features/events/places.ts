import * as Location from 'expo-location';
import { Platform } from 'react-native';

// Finding a venue's position for the Add Sub-Event sheet. iOS pins it on Apple Maps as well;
// Android has no map until its Google Maps key arrives, so there a venue comes from a search
// result or the phone's own position (S-02 card, decided at build mobile).

export interface Place {
  lat: number;
  lng: number;
  // A short name the venue field starts with, which the user can change.
  name: string;
  // The address line under a search result.
  address: string;
}

export class PlacesError extends Error {
  readonly reason: 'permission' | 'unavailable' | 'not_found';

  constructor(reason: PlacesError['reason'], message: string) {
    super(message);
    this.name = 'PlacesError';
    this.reason = reason;
  }
}

// Search results past this many are not looked up. Each needs its own reverse geocode, and both
// platforms refuse a burst of requests.
const MAX_RESULTS = 5;

// A name and an address line from a reverse geocode, falling back to `fallback` for the name.
export function describeAddress(
  address: Location.LocationGeocodedAddress | undefined,
  fallback: string,
): { name: string; address: string } {
  if (address === undefined) {
    return { name: fallback, address: '' };
  }
  const street = [address.streetNumber, address.street].filter(Boolean).join(' ');
  const line = address.formattedAddress
    ? address.formattedAddress
    : [street, address.district, address.city, address.region, address.country]
        .filter((part, index, parts) => Boolean(part) && parts.indexOf(part) === index)
        .join(', ');
  const name = address.name && address.name !== address.streetNumber ? address.name : fallback;
  return { name: name.trim() || fallback, address: line };
}

async function ensurePermission(): Promise<void> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return;
  if (!current.canAskAgain) {
    throw new PlacesError('permission', 'Location is off for MomentLens.');
  }
  const asked = await Location.requestForegroundPermissionsAsync();
  if (!asked.granted) {
    throw new PlacesError('permission', 'Location is off for MomentLens.');
  }
}

async function describe(lat: number, lng: number, fallback: string) {
  try {
    const [address] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    return describeAddress(address, fallback);
  } catch {
    return { name: fallback, address: '' };
  }
}

// Places matching an address or a place name. Android's geocoder needs location permission and
// iOS's does not (Expo SDK 57 expo-location).
export async function searchPlaces(query: string): Promise<Place[]> {
  const text = query.trim();
  if (Platform.OS === 'android') {
    await ensurePermission();
  }
  let found: Location.LocationGeocodedLocation[];
  try {
    found = await Location.geocodeAsync(text);
  } catch {
    throw new PlacesError('unavailable', 'Search is not available right now.');
  }
  if (found.length === 0) {
    throw new PlacesError('not_found', 'Nothing matched that search.');
  }
  const places: Place[] = [];
  // One after another, never in parallel, for the rate limits above.
  for (const result of found.slice(0, MAX_RESULTS)) {
    const described = await describe(result.latitude, result.longitude, text);
    places.push({ lat: result.latitude, lng: result.longitude, ...described });
  }
  return places;
}

// Where the phone is now, for "Use my current location".
export async function currentPlace(): Promise<Place> {
  await ensurePermission();
  let position: Location.LocationObject;
  try {
    position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  } catch {
    throw new PlacesError('unavailable', 'Your location could not be found.');
  }
  const { latitude: lat, longitude: lng } = position.coords;
  return { lat, lng, ...(await describe(lat, lng, 'Current location')) };
}

// A name and address for a point the user dropped a pin on (iOS).
export async function describePoint(lat: number, lng: number): Promise<Place> {
  return { lat, lng, ...(await describe(lat, lng, 'Pinned location')) };
}
