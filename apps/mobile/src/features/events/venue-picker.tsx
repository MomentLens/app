import { EventName } from '@momentlens/shared-types';
import { randomUUID } from 'expo-crypto';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field-group';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section } from '@/components/ui/grouped';
import { SearchField } from '@/components/ui/search-field';
import { TextField } from '@/components/ui/text-field';
import type { DraftVenue } from '@/features/events/draft';
import { formatRadius } from '@/features/events/format';
import {
  currentPlace,
  describePoint,
  PlacesError,
  searchPlaces,
  type Place,
} from '@/features/events/places';
import { MAP_AVAILABILITY, VenueMap } from '@/features/events/venue-map';
import type { LatLng } from '@/features/events/venue-map.types';
import { useTokenColor } from '@/hooks/use-token-color';
import { byPlatform } from '@/lib/copy';

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

// "Find a venue" in the Add Sub-Event sheet: a new venue from an address search, the phone's own
// position, or on iOS a pin on Apple Maps (spec §2.1.2, D-110, D-111). On iOS the map fills the
// sheet with the search over it, and a card at the foot names the venue once it has a point
// (D-128). Android lists results and the phone's position until the Google Maps key is in the
// build. A venue made here is new; picking one an earlier sub-event added happens in the form.
export function VenuePicker({ radiusM, onDone, onBack }: VenuePickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState<'search' | 'here' | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [point, setPoint] = useState<LatLng | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  // Whether the name came from the place, so moving the pin may replace it, or was typed.
  const [nameFromPlace, setNameFromPlace] = useState(true);
  // The point most recently chosen, so a slow description of an older pin cannot rename it.
  const latest = useRef<LatLng | null>(null);
  const map = MAP_AVAILABILITY === 'map';

  function choose(place: Place) {
    latest.current = { lat: place.lat, lng: place.lng };
    setPoint(latest.current);
    setName(place.name);
    setAddress(place.address);
    setNameFromPlace(true);
    setProblem(null);
    // On the map the results panel gives way to the pin.
    if (map) setResults(null);
  }

  async function search() {
    if (query.trim() === '' || busy) return;
    setBusy('search');
    setProblem(null);
    try {
      setResults(await searchPlaces(query));
    } catch (error) {
      // No match is an empty list, said in the results, not an error (D-128).
      if (error instanceof PlacesError && error.reason === 'not_found') {
        setResults([]);
      } else {
        setResults(null);
        setProblem(problemFrom(error));
      }
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
    setResults(null);
    if (!nameFromPlace) return;
    const described = await describePoint(next.lat, next.lng);
    if (latest.current === next) {
      setName(described.name);
      setAddress(described.address);
    }
  }

  const nameOk = EventName.safeParse(name).success;
  const place = point
    ? { key: randomUUID(), name: name.trim(), lat: point.lat, lng: point.lng }
    : null;
  const where = [address, `${formatRadius(radiusM)} radius`].filter(Boolean).join(' · ');

  const header = (
    <View className="h-14 flex-row items-center ios:px-4 android:px-1">
      <BackButton label="Back to the sub-event" onPress={onBack} />
      <Text
        accessibilityRole="header"
        className="flex-1 font-h2 ios:mr-11 ios:text-center ios:text-body android:px-1 android:text-h2 text-textPrimary">
        {byPlatform('Find a Venue', 'Find a venue')}
      </Text>
    </View>
  );

  const search_ = (
    <SearchField
      placeholder={byPlatform('Hall, hotel or address', 'Search halls, hotels, addresses')}
      value={query}
      onChangeText={(text) => {
        setQuery(text);
        if (text === '') setResults(null);
      }}
      returnKeyType="search"
      onSubmitEditing={() => void search()}
      autoCorrect={false}
    />
  );

  const problemLine = problem ? (
    <View className="gap-1">
      <Text accessibilityRole="alert" className="font-bodySecondary text-bodySecondary text-danger">
        {problem.message}
      </Text>
      {problem.settings ? (
        <Text
          accessibilityRole="link"
          onPress={() => void Linking.openSettings()}
          className="font-fieldLabel text-bodySecondary text-accentText">
          Open Settings
        </Text>
      ) : null}
    </View>
  ) : null;

  if (!map) {
    return (
      <View className="flex-1">
        {header}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 pb-10">
          <View className="gap-3 px-4">
            {search_}
            {problemLine}
          </View>
          <Section>
            <Row
              leading={<Glyph name={GLYPH.location} size={22} tone="accentText" />}
              title="Use my current location"
              trailing={busy === 'here' ? <ActivityIndicator /> : undefined}
              onPress={() => void takeCurrentPlace()}
            />
          </Section>
          {busy === 'search' ? (
            <ActivityIndicator className="text-textSecondary" />
          ) : results !== null ? (
            results.length > 0 ? (
              <Section header="Results">
                {results.map((candidate, i) => (
                  <Row
                    key={`${candidate.lat},${candidate.lng},${i}`}
                    leading={<Glyph name={GLYPH.pin} size={22} tone="textSecondary" />}
                    title={candidate.name}
                    subtitle={candidate.address ?? undefined}
                    onPress={() => choose(candidate)}
                  />
                ))}
              </Section>
            ) : (
              <Text className="px-8 font-body text-body text-textSecondary">
                No results for “{query.trim()}”.
              </Text>
            )
          ) : null}
          {point ? (
            <View className="gap-4">
              <FieldGroup>
                <TextField
                  label="Venue name"
                  placeholder="What guests call it"
                  value={name}
                  onChangeText={(text) => {
                    setName(text);
                    setNameFromPlace(false);
                  }}
                  helper={where}
                  error={name.trim() !== '' && !nameOk ? 'Keep the name to 80 characters.' : null}
                />
              </FieldGroup>
              <View className="px-4">
                <Button
                  label="Use this venue"
                  disabled={!nameOk}
                  onPress={() => place && onDone(place)}
                />
              </View>
            </View>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1">
      {header}
      <View className="gap-2 px-4 pb-3">
        {search_}
        {problemLine}
      </View>
      <View className="flex-1 overflow-hidden">
        <VenueMap point={point} radiusM={radiusM} onPick={(next) => void pin(next)} />

        {busy === 'search' || results !== null ? (
          <ResultsPanel
            busy={busy === 'search'}
            results={results ?? []}
            query={query.trim()}
            onChoose={choose}
          />
        ) : null}

        <View className="absolute bottom-0 left-0 right-0 gap-3 p-3">
          <View className="items-end">
            <GlassButton label="Use my current location" onPress={() => void takeCurrentPlace()}>
              {busy === 'here' ? (
                <ActivityIndicator />
              ) : (
                <Glyph name={GLYPH.location} size={20} tone="textPrimary" />
              )}
            </GlassButton>
          </View>
          {/* Keyed, so the card mounts fresh rather than restyling the hint's view: a view whose
              classes gain a shadow after its first render makes NativeWind remount it, and its
              development warning crashed. */}
          {point ? (
            <View key="card" className="gap-3 rounded-[26px] bg-surface p-4 shadow-lg">
              <View className="gap-0.5">
                <Text className="font-caption text-caption text-textSecondary">
                  Venue name, as guests will see it
                </Text>
                <NameInput
                  value={name}
                  onChangeText={(text) => {
                    setName(text);
                    setNameFromPlace(false);
                  }}
                />
                <Text numberOfLines={1} className="font-caption text-caption text-textSecondary">
                  {name.trim() !== '' && !nameOk ? 'Keep the name to 80 characters.' : where}
                </Text>
              </View>
              <Button
                label="Use This Venue"
                disabled={!nameOk}
                onPress={() => place && onDone(place)}
              />
            </View>
          ) : (
            <View key="hint" className="items-center">
              <View className="rounded-full bg-surface/90 px-4 py-2">
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  Search, or tap the map to drop a pin
                </Text>
              </View>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

function NameInput({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (text: string) => void;
}) {
  const caret = useTokenColor('accentText');
  const muted = useTokenColor('textMuted');
  return (
    <TextInput
      accessibilityLabel="Venue name"
      value={value}
      onChangeText={onChangeText}
      placeholder="What guests call it"
      placeholderTextColor={muted}
      selectionColor={caret}
      style={{ paddingVertical: 2 }}
      className="font-h2 text-body text-textPrimary"
    />
  );
}

// The search's results over the top of the map, under the field (D-128). No match is said in the
// panel, not in a red banner: an empty search is not an error.
function ResultsPanel({
  busy,
  results,
  query,
  onChoose,
}: {
  busy: boolean;
  results: readonly Place[];
  query: string;
  onChoose: (place: Place) => void;
}) {
  return (
    <View className="absolute left-4 right-4 top-1 overflow-hidden rounded-[22px] bg-surface shadow-lg">
      {busy ? (
        <View className="items-center py-5">
          <ActivityIndicator />
        </View>
      ) : results.length === 0 ? (
        <Text className="px-4 py-4 font-body text-body text-textSecondary">
          No results for “{query}”.
        </Text>
      ) : (
        results.map((candidate, i) => (
          <Pressable
            key={`${candidate.lat},${candidate.lng},${i}`}
            accessibilityRole="button"
            onPress={() => onChoose(candidate)}
            className={`flex-row items-center gap-3 px-4 py-3 active:bg-surfaceMuted ${i > 0 ? 'border-t border-border' : ''}`}>
            <View className="h-8 w-8 items-center justify-center rounded-full bg-danger">
              <Glyph name={GLYPH.pin} size={16} tone="onPhoto" />
            </View>
            <View className="flex-1">
              <Text numberOfLines={1} className="font-h2 text-bodySecondary text-textPrimary">
                {candidate.name}
              </Text>
              {candidate.address ? (
                <Text numberOfLines={1} className="font-caption text-caption text-textSecondary">
                  {candidate.address}
                </Text>
              ) : null}
            </View>
          </Pressable>
        ))
      )}
    </View>
  );
}
