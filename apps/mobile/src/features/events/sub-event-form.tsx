import { VERIFICATION_RADIUS_MAX_M, VERIFICATION_RADIUS_MIN_M } from '@momentlens/shared-types';
import { Slider } from '@expo/ui';
import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';

import { FieldGroup } from '@/components/ui/field-group';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section } from '@/components/ui/grouped';
import { SheetToolbar } from '@/components/ui/sheet-toolbar';
import { TextField } from '@/components/ui/text-field';
import { TintedHost } from '@/components/ui/tinted-host';
import { DateTimeField } from '@/features/events/date-time-field';
import type { DraftVenue } from '@/features/events/draft';
import { formatRadius } from '@/features/events/format';
import {
  subEventFormProblems,
  type SubEventForm as SubEventFormState,
  type SubEventValues,
} from '@/features/events/validation';
import { VenuePicker } from '@/features/events/venue-picker';
import { byPlatform } from '@/lib/copy';

// The slider's step. Whole metres only, as the API checks (D-111).
const RADIUS_STEP_M = 10;

interface SubEventFormProps {
  title: string;
  submitLabel: string;
  // What the fields start from. Read once, when the form mounts.
  initial: SubEventFormState;
  // Venues to pick from, which other sub-events already use. A venue made in the picker joins them.
  venues: readonly DraftVenue[];
  onSubmit: (values: SubEventValues) => void;
  onClose: () => void;
  // While the caller's write is running: the toolbar's save spins and ignores presses.
  busy?: boolean;
  // A message about the whole form, such as what the API refused.
  problem?: string | null;
  // A line under the venue for the chosen one, such as a QR that stops working (D-121).
  venueNote?: (venue: DraftVenue | null) => string | null;
  // Under the form, for Remove or Delete at its foot.
  footer?: ReactNode;
}

// A field's problem under its section, in the danger tone and announced when it appears.
function FieldProblem({ message }: { message: string }) {
  return (
    <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
      {message}
    </Text>
  );
}

// Android's radio button, which Material 3 draws on a list item that picks one of several.
function Radio({ selected }: { selected: boolean }) {
  return (
    <View
      className={`h-5 w-5 items-center justify-center rounded-full border-2 ${selected ? 'border-accentText' : 'border-textSecondary'}`}>
      {selected ? <View className="h-2.5 w-2.5 rounded-full bg-accentText" /> : null}
    </View>
  );
}

// A sub-event's name, start and end, venue and radius (spec §2.1.2, D-111), as the wizard's Add
// Sub-Event sheet and the Schedule's Add and Edit sheets share it. A grouped form under the sheet's
// toolbar, which saves (D-124, D-125); the times use each platform's own pickers (D-128). Each
// caller decides what saving does; the form only checks the fields with the shared schema's rules.
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
      <VenuePicker
        radiusM={radiusM}
        onBack={() => setMode('form')}
        onDone={(picked) => {
          setVenue(picked);
          setMode('form');
        }}
      />
    );
  }

  const radiusLine = `Guests must be within ${formatRadius(radiusM)} of the venue for their photos to upload.`;

  return (
    <View className="flex-1">
      <SheetToolbar
        title={title}
        onClose={onClose}
        confirm={{ label: submitLabel, kind: 'done', busy, onPress: submit }}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-6 pb-10 pt-2">
        <FieldGroup>
          <TextField
            label="Name"
            placeholder="Mehndi, Nikah, Walima"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            error={problems.name}
          />
        </FieldGroup>

        <FieldGroup header="Time">
          <DateTimeField
            label="Starts"
            dateLabel="Start date"
            timeLabel="Start time"
            value={startsAt}
            onChange={changeStart}
          />
          <DateTimeField
            label="Ends"
            dateLabel="End date"
            timeLabel="End time"
            value={endsAt}
            onChange={setEndsAt}
            error={problems.endsAt}
          />
        </FieldGroup>

        <Section
          header="Venue"
          footer={problems.venue ? <FieldProblem message={problems.venue} /> : (note ?? undefined)}>
          {venues.map((candidate) => {
            const selected = candidate.key === venue?.key;
            return (
              <Row
                key={candidate.key}
                title={candidate.name}
                leading={Platform.OS === 'android' ? <Radio selected={selected} /> : undefined}
                trailing={
                  Platform.OS === 'ios' && selected ? (
                    <Glyph name={GLYPH.check} size={18} tone="accentText" />
                  ) : undefined
                }
                accessibilityLabel={`${candidate.name}${selected ? ', selected' : ''}`}
                onPress={() => setVenue(candidate)}
              />
            );
          })}
          <Row
            leading={<Glyph name={GLYPH.venue} size={22} tone="accentText" />}
            title={byPlatform('Find a Venue…', 'Find a venue')}
            action
            onPress={() => setMode('venue')}
          />
        </Section>

        <Section
          header={byPlatform('Check-In Radius', 'Check-in radius')}
          footer={problems.radiusM ? <FieldProblem message={problems.radiusM} /> : radiusLine}>
          <Row
            trailing={
              <Text className="font-body text-body text-textSecondary">
                {formatRadius(radiusM)}
              </Text>
            }>
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
          </Row>
        </Section>

        {problem ? (
          <View className="ios:px-5 android:px-4">
            <FormMessage message={problem} />
          </View>
        ) : null}
        {footer}
      </ScrollView>
    </View>
  );
}
