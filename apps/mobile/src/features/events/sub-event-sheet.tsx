import {
  VERIFICATION_RADIUS_DEFAULT_M,
  VERIFICATION_RADIUS_MAX_M,
  VERIFICATION_RADIUS_MIN_M,
} from '@momentlens/shared-types';
import { BottomSheet, Host, RNHostView, Slider } from '@expo/ui';
import { randomUUID } from 'expo-crypto';
import { cssInterop } from 'nativewind';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TextField } from '@/components/ui/text-field';
import { DateTimeField } from '@/features/events/date-time-field';
import {
  removeSubEvent,
  saveSubEvent,
  useEventDraft,
  type DraftSubEvent,
  type DraftVenue,
} from '@/features/events/draft';
import { formatRadius } from '@/features/events/format';
import { draftVenues } from '@/features/events/request';
import { defaultSubEventTimes } from '@/features/events/time';
import { subEventFormProblems } from '@/features/events/validation';
import { VenuePicker } from '@/features/events/venue-picker';
import { FieldError, FieldLabel } from '@/features/events/wizard-frame';

// The slider's step. Whole metres only, as the API checks (D-111).
const RADIUS_STEP_M = 10;

// Host takes its tint as a prop. This moves a text-* token's color onto it, as icon.tsx does for
// an Svg, so the slider is gold in both modes with no hex in a component.
const TintedHost = cssInterop(Host, {
  className: { target: 'style', nativeStyleToProp: { color: 'seedColor' } },
});

// The sheet's own chrome takes a color prop too. Painting it with the surface token, and dropping
// its default inset, stops the platform's grey showing as a frame around the content.
const SurfaceSheet = cssInterop(BottomSheet, {
  className: { target: false, nativeStyleToProp: { backgroundColor: 'containerColor' } },
});

export type SheetTarget = { kind: 'new' } | { kind: 'edit'; subEvent: DraftSubEvent };

interface SubEventSheetProps {
  // What the sheet is open on, or null while it is closed.
  target: SheetTarget | null;
  onClose: () => void;
}

// The Add Sub-Event sheet on step 2 (spec §2.1.2, D-111): name, start and end, venue and radius.
// The pencil reopens it on a sub-event already added. React Native content sits in RNHostView
// inside @expo/ui's BottomSheet (apps/mobile/CLAUDE.md).
export function SubEventSheet({ target, onClose }: SubEventSheetProps) {
  // What the sheet shows, which outlives `target` so the content stays put while the sheet slides
  // away instead of blanking first. Each opening gets its own number, so a second "Add" starts
  // empty rather than keeping the first one's typing.
  const [shown, setShown] = useState<{ target: SheetTarget; opening: number } | null>(null);
  if (target !== null && target !== shown?.target) {
    setShown({ target, opening: (shown?.opening ?? 0) + 1 });
  }

  return (
    <SurfaceSheet
      isPresented={target !== null}
      onDismiss={onClose}
      snapPoints={['full']}
      contentPadding={0}
      className="bg-surface">
      <RNHostView>
        <View className="flex-1 bg-surface">
          {shown ? (
            <SheetContent key={shown.opening} target={shown.target} onClose={onClose} />
          ) : null}
        </View>
      </RNHostView>
    </SurfaceSheet>
  );
}

function SheetContent({ target, onClose }: { target: SheetTarget; onClose: () => void }) {
  const subEvents = useEventDraft((state) => state.subEvents);
  const editing = target.kind === 'edit' ? target.subEvent : null;
  const [initialTimes] = useState(() => editing ?? defaultSubEventTimes(subEvents, new Date()));

  const [mode, setMode] = useState<'form' | 'venue'>('form');
  const [name, setName] = useState(editing?.name ?? '');
  const [startsAt, setStartsAt] = useState(initialTimes.startsAt);
  const [endsAt, setEndsAt] = useState(initialTimes.endsAt);
  const [venue, setVenue] = useState<DraftVenue | null>(editing?.venue ?? null);
  const [radiusM, setRadiusM] = useState(editing?.radiusM ?? VERIFICATION_RADIUS_DEFAULT_M);
  const [openWheel, setOpenWheel] = useState<'start' | 'end' | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  // Venues the other sub-events use, and this one's own, which may be new.
  const others = draftVenues(subEvents.filter((subEvent) => subEvent.key !== editing?.key));
  const venues =
    venue && !others.some((known) => known.key === venue.key) ? [...others, venue] : others;

  const form = { name, startsAt, endsAt, venue, radiusM };
  const problems = showProblems ? subEventFormProblems(form) : {};

  // Moving the start keeps the length, so an end that was after the start stays after it.
  function changeStart(next: Date) {
    setEndsAt(new Date(next.getTime() + (endsAt.getTime() - startsAt.getTime())));
    setStartsAt(next);
  }

  function save() {
    setShowProblems(true);
    if (Object.keys(subEventFormProblems(form)).length > 0 || venue === null) return;
    saveSubEvent({
      key: editing?.key ?? randomUUID(),
      name: name.trim(),
      startsAt,
      endsAt,
      venue,
      radiusM,
    });
    onClose();
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
          {editing ? 'Edit Sub-Event' : 'Add Sub-Event'}
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
            {venues.map((known, i) => {
              const selected = known.key === venue?.key;
              return (
                <Pressable
                  key={known.key}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => setVenue(known)}
                  className={`min-h-12 flex-row items-center gap-3 px-4 active:bg-surfaceMuted ${i > 0 ? 'border-t border-border' : ''}`}>
                  <Icon
                    name="map-pin"
                    size={16}
                    className={selected ? 'text-accent' : 'text-textMuted'}
                  />
                  <Text className="flex-1 font-body text-body text-textPrimary">{known.name}</Text>
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

      <Button label={editing ? 'Save Sub-Event' : 'Add Sub-Event'} onPress={save} />
      {editing ? (
        <Button
          label="Remove sub-event"
          variant="quiet"
          onPress={() => {
            removeSubEvent(editing.key);
            onClose();
          }}
        />
      ) : null}
    </ScrollView>
  );
}
