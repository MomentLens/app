import { VERIFICATION_RADIUS_MAX_M, VERIFICATION_RADIUS_MIN_M } from '@momentlens/shared-types';
import { Host, Slider } from '@expo/ui';
import { cssInterop } from 'nativewind';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { TextField } from '@/components/ui/text-field';
import { DateTimeField } from '@/features/events/date-time-field';
import type { DraftVenue } from '@/features/events/draft';
import { formatRadius } from '@/features/events/format';
import {
  subEventFormProblems,
  type SubEventForm as SubEventFormState,
  type SubEventValues,
} from '@/features/events/validation';
import { VenuePicker } from '@/features/events/venue-picker';
import { FieldError, FieldLabel } from '@/features/events/wizard-frame';

// The slider's step. Whole metres only, as the API checks (D-111).
const RADIUS_STEP_M = 10;

// Host takes its tint as a prop. This moves a text-* token's color onto it, as icon.tsx does for
// an Svg, so the slider is gold in both modes with no hex in a component.
const TintedHost = cssInterop(Host, {
  className: { target: 'style', nativeStyleToProp: { color: 'seedColor' } },
});

interface SubEventFormProps {
  title: string;
  submitLabel: string;
  // What the fields start from. Read once, when the form mounts.
  initial: SubEventFormState;
  // Venues to pick from, which other sub-events already use. A venue made in the picker joins them.
  venues: readonly DraftVenue[];
  onSubmit: (values: SubEventValues) => void;
  onClose: () => void;
  // While the caller's write is running: the submit button spins and ignores presses.
  busy?: boolean;
  // A message about the whole form, such as what the API refused.
  problem?: string | null;
  // A line under the venue for the chosen one, such as a QR that stops working (D-121).
  venueNote?: (venue: DraftVenue | null) => string | null;
  // Under the submit button, for Remove or Delete.
  footer?: ReactNode;
}

// A sub-event's name, start and end, venue and radius (spec §2.1.2, D-111), as the wizard's Add
// Sub-Event sheet and the Schedule's Add and Edit sheets share it. Each caller decides what saving
// does; the form only checks the fields with the shared schema's rules.
export function SubEventForm({
  title,
  submitLabel,
  initial,
  venues: known,
  onSubmit,
  onClose,
  busy = false,
  problem,
  venueNote,
  footer,
}: SubEventFormProps) {
  const [mode, setMode] = useState<'form' | 'venue'>('form');
  const [name, setName] = useState(initial.name);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [venue, setVenue] = useState<DraftVenue | null>(initial.venue);
  const [radiusM, setRadiusM] = useState(initial.radiusM);
  const [openWheel, setOpenWheel] = useState<'start' | 'end' | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  // The known venues, and this one's own when the picker made it.
  const venues =
    venue && !known.some((candidate) => candidate.key === venue.key) ? [...known, venue] : known;

  const form = { name, startsAt, endsAt, venue, radiusM };
  const problems = showProblems ? subEventFormProblems(form) : {};
  const note = venueNote?.(venue) ?? null;

  // Moving the start keeps the length, so an end that was after the start stays after it.
  function changeStart(next: Date) {
    setEndsAt(new Date(next.getTime() + (endsAt.getTime() - startsAt.getTime())));
    setStartsAt(next);
  }

  function submit() {
    setShowProblems(true);
    if (Object.keys(subEventFormProblems(form)).length > 0 || venue === null) return;
    onSubmit({ name: name.trim(), startsAt, endsAt, venue, radiusM });
  }

  if (mode === 'venue') {
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-4 pb-10 pt-6">
        <VenuePicker
          radiusM={radiusM}
          onBack={() => setMode('form')}
          onDone={(picked) => {
            setVenue(picked);
            setMode('form');
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-5 px-4 pb-10 pt-6">
      <View className="flex-row items-center justify-between">
        <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
          {title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}
          onPress={onClose}>
          <Icon name="x" size={20} className="text-textSecondary" />
        </Pressable>
      </View>

      <TextField
        label="Name"
        placeholder="Sub-event name, e.g. Nikkah"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        error={problems.name}
      />
      <DateTimeField
        label="Start date and time"
        value={startsAt}
        onChange={changeStart}
        open={openWheel === 'start'}
        onToggle={() => setOpenWheel((open) => (open === 'start' ? null : 'start'))}
      />
      <DateTimeField
        label="End date and time"
        value={endsAt}
        onChange={setEndsAt}
        open={openWheel === 'end'}
        onToggle={() => setOpenWheel((open) => (open === 'end' ? null : 'end'))}
        error={problems.endsAt}
      />

      <View className="gap-2">
        <FieldLabel>Venue</FieldLabel>
        {venues.length > 0 ? (
          <View
            accessibilityRole="radiogroup"
            className="overflow-hidden rounded-xl border border-border bg-surface">
            {venues.map((candidate, i) => {
              const selected = candidate.key === venue?.key;
              return (
                <Pressable
                  key={candidate.key}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => setVenue(candidate)}
                  className={`min-h-12 flex-row items-center gap-3 px-4 active:bg-surfaceMuted ${i > 0 ? 'border-t border-border' : ''}`}>
                  <Icon
                    name="map-pin"
                    size={16}
                    className={selected ? 'text-accent' : 'text-textMuted'}
                  />
                  <Text className="flex-1 font-body text-body text-textPrimary">
                    {candidate.name}
                  </Text>
                  {selected ? <Icon name="check" size={18} className="text-accent" /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <Button
          label="Search or pin on map"
          variant="secondary"
          icon="map-pin"
          onPress={() => setMode('venue')}
        />
        <FieldError message={problems.venue} />
        {note ? <Text className="font-caption text-caption text-textSecondary">{note}</Text> : null}
      </View>

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <FieldLabel>Verification radius</FieldLabel>
          <Text className="font-fieldLabel text-fieldLabel text-accentText">
            {formatRadius(radiusM)}
          </Text>
        </View>
        <TintedHost
          matchContents={{ vertical: true }}
          style={{ width: '100%' }}
          className="text-accent">
          <Slider
            value={radiusM}
            min={VERIFICATION_RADIUS_MIN_M}
            max={VERIFICATION_RADIUS_MAX_M}
            step={RADIUS_STEP_M}
            onValueChange={(value) => setRadiusM(Math.round(value))}
          />
        </TintedHost>
        <View className="flex-row justify-between">
          <Text className="font-caption text-caption text-textMuted">
            {formatRadius(VERIFICATION_RADIUS_MIN_M)}
          </Text>
          <Text className="font-caption text-caption text-textMuted">
            {formatRadius(VERIFICATION_RADIUS_MAX_M)}
          </Text>
        </View>
        <FieldError message={problems.radiusM} />
      </View>

      {problem ? <FormMessage message={problem} /> : null}
      <Button label={submitLabel} busy={busy} onPress={submit} />
      {footer}
    </ScrollView>
  );
}
