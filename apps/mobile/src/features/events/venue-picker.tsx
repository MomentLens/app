import { EventName } from '@momentlens/shared-types';
import { randomUUID } from 'expo-crypto';
import { useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TextField } from '@/components/ui/text-field';
import type { DraftVenue } from '@/features/events/draft';
import {
  currentPlace,
  describePoint,
  PlacesError,
  searchPlaces,
  type Place,
} from '@/features/events/places';
import { MAP_AVAILABILITY, VenueMap } from '@/features/events/venue-map';
import type { LatLng } from '@/features/events/venue-map.types';

interface VenuePickerProps {
  radiusM: number;
  onDone: (venue: DraftVenue) => void;
  onBack: () => void;
}

interface Problem {
  message: string;
  // Location permission was refused for good, so only Settings can turn it back on.
  settings: boolean;
}

function problemFrom(error: unknown): Problem {
  if (error instanceof PlacesError) {
    if (error.reason === 'permission') {
      return {
        message: 'Location is off for MomentLens. Turn it on in Settings to find the venue.',
        settings: true,
      };
    }
    return { message: error.message, settings: false };
  }
  return { message: 'That did not work. Try again.', settings: false };
}

// "Search or pin on map" in the Add Sub-Event sheet: a new venue from an address search, the
// phone's own position, or on iOS a pin on Apple Maps (spec §2.1.2, D-110, D-111). A venue made
// here is new; picking one an earlier sub-event added happens in the sheet itself.
export function VenuePicker({ radiusM, onDone, onBack }: VenuePickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [busy, setBusy] = useState<'search' | 'here' | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [point, setPoint] = useState<LatLng | null>(null);
  const [name, setName] = useState('');
  // Whether the name came from the place, so moving the pin may replace it, or was typed.
  const [nameFromPlace, setNameFromPlace] = useState(true);
  // The point most recently chosen, so a slow description of an older pin cannot rename it.
  const latest = useRef<LatLng | null>(null);

  function choose(place: Place) {
    latest.current = { lat: place.lat, lng: place.lng };
    setPoint(latest.current);
    setName(place.name);
    setNameFromPlace(true);
    setProblem(null);
  }

  async function search() {
    if (query.trim() === '' || busy) return;
    setBusy('search');
    setProblem(null);
    try {
      setResults(await searchPlaces(query));
    } catch (error) {
      setResults([]);
      setProblem(problemFrom(error));
    } finally {
      setBusy(null);
    }
  }

  async function takeCurrentPlace() {
    if (busy) return;
    setBusy('here');
    setProblem(null);
    try {
      choose(await currentPlace());
    } catch (error) {
      setProblem(problemFrom(error));
    } finally {
      setBusy(null);
    }
  }

  async function pin(next: LatLng) {
    latest.current = next;
    setPoint(next);
    if (!nameFromPlace) return;
    const described = await describePoint(next.lat, next.lng);
    if (latest.current === next) setName(described.name);
  }

  const nameOk = EventName.safeParse(name).success;

  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to the sub-event"
          hitSlop={12}
          onPress={onBack}
          className="h-11 w-11 justify-center">
          <Icon name="chevron-left" size={22} className="text-textPrimary" />
        </Pressable>
        <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
          Find the venue
        </Text>
      </View>

      <TextField
        label="Search"
        icon="search"
        placeholder="Hall, hotel or address"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        onSubmitEditing={() => void search()}
        autoCorrect={false}
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Search"
            variant="secondary"
            icon="search"
            busy={busy === 'search'}
            disabled={query.trim() === ''}
            onPress={() => void search()}
          />
        </View>
        <View className="flex-1">
          <Button
            label="Where I am"
            variant="secondary"
            icon="locate-fixed"
            busy={busy === 'here'}
            onPress={() => void takeCurrentPlace()}
          />
        </View>
      </View>

      {problem ? (
        <View className="gap-1 rounded-xl bg-dangerTint px-4 py-3">
          <Text
            accessibilityRole="alert"
            className="font-bodySecondary text-bodySecondary text-danger">
            {problem.message}
          </Text>
          {problem.settings ? (
            <Text
              accessibilityRole="link"
              onPress={() => void Linking.openSettings()}
              className="font-caption text-caption text-accentText underline">
              Open Settings
            </Text>
          ) : null}
        </View>
      ) : null}

      {results.length > 0 ? (
        <View
          accessibilityRole="list"
          className="overflow-hidden rounded-xl border border-border bg-surface">
          {results.map((place, i) => {
            const selected = point?.lat === place.lat && point.lng === place.lng;
            return (
              <Pressable
                key={`${place.lat},${place.lng},${i}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => choose(place)}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-surfaceMuted ${i > 0 ? 'border-t border-border' : ''}`}>
                <Icon
                  name="map-pin"
                  size={18}
                  className={selected ? 'text-accent' : 'text-textMuted'}
                />
                <View className="flex-1">
                  <Text className="font-fieldLabel text-fieldLabel text-textPrimary">
                    {place.name}
                  </Text>
                  {place.address ? (
                    <Text
                      numberOfLines={2}
                      className="font-caption text-caption text-textSecondary">
                      {place.address}
                    </Text>
                  ) : null}
                </View>
                {selected ? <Icon name="check" size={18} className="text-accent" /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <VenueMap point={point} radiusM={radiusM} onPick={(next) => void pin(next)} />

      {point ? (
        <>
          <TextField
            label="Venue name"
            placeholder="What guests call it"
            value={name}
            onChangeText={(text) => {
              setName(text);
              setNameFromPlace(false);
            }}
            error={name.trim() !== '' && !nameOk ? 'Keep the name to 80 characters.' : null}
          />
          <Button
            label="Use this venue"
            disabled={!nameOk}
            onPress={() =>
              onDone({ key: randomUUID(), name: name.trim(), lat: point.lat, lng: point.lng })
            }
          />
        </>
      ) : MAP_AVAILABILITY === 'map' ? null : (
        <Text className="font-caption text-caption text-textSecondary">
          Pick a search result or use where you are.
        </Text>
      )}
    </View>
  );
}
