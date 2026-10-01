import { subEventStatus, type SubEvent } from '@momentlens/shared-types';
import WheelPicker, { type PickerItem } from '@quidone/react-native-wheel-picker';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { formatSubEventTimes } from '@/features/events/format';
import { MINUTE_STEP } from '@/features/events/time';
import { FieldLabel } from '@/features/events/wizard-frame';
import { delayedTimes } from '@/features/schedule/schedule';
import { useSubEvents, writeSchedule } from '@/features/schedule/use-sub-events';
import { updateSubEvent } from '@/lib/api';

const MINUTE_MS = 60 * 1000;

// The amounts a late sub-event most often needs, one tap each. The wheels take any other up to a
// day less five minutes; a bigger move is an edit of the times (spec §4.3).
const QUICK_MINUTES = [15, 30, 60, 120];
const DEFAULT_MINUTES = 30;

const ITEM_HEIGHT = 36;
const VISIBLE_ITEMS = 3;

const HOURS: PickerItem<number>[] = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: `${i} h`,
}));
const MINUTES: PickerItem<number>[] = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => ({
  value: i * MINUTE_STEP,
  label: `${String(i * MINUTE_STEP).padStart(2, '0')} min`,
}));

function renderItem({ item }: { item: PickerItem<number> }) {
  return (
    <Text numberOfLines={1} className="w-full text-center font-body text-body text-textPrimary">
      {item.label}
    </Text>
  );
}

function quickLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
}

interface DelaySheetProps {
  eventId: string;
  // The sub-event being delayed, by id, so the sheet always reads the latest copy.
  subEventId: string | null;
  // The Schedule's own clock, which decides whether the start moves.
  now: Date;
  onClose: () => void;
}

// The Admin's Delay (spec §2.5.5, D-121): a positive amount, turned into new absolute times and sent
// through the edit endpoint. One button does two things depending on the clock, so the sheet shows
// the times it will send before anything is sent.
export function DelaySheet({ eventId, subEventId, now, onClose }: DelaySheetProps) {
  return (
    <Sheet target={subEventId} onClose={onClose}>
      {(id) => <DelayContent eventId={eventId} subEventId={id} now={now} onClose={onClose} />}
    </Sheet>
  );
}

function DelayContent({
  eventId,
  subEventId,
  now,
  onClose,
}: {
  eventId: string;
  subEventId: string;
  now: Date;
  onClose: () => void;
}) {
  const subEvent = useSubEvents(eventId).data?.subEvents.find(
    (candidate) => candidate.id === subEventId,
  );
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  // The body last sent, kept so that trying again after a failure sends exactly the same times,
  // even if the cached schedule has since caught up with a first attempt that did land.
  const [sent, setSent] = useState<{ minutes: number; body: ReturnType<typeof delayedTimes> }>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (subEvent === undefined) {
    return (
      <View className="gap-4 px-4 pb-10 pt-6">
        <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
          This sub-event is gone
        </Text>
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          It was deleted on another phone.
        </Text>
        <Button label="Close" variant="secondary" onPress={onClose} />
      </View>
    );
  }

  const retry = sent !== undefined && sent.minutes === minutes;
  const next = retry ? sent.body : delayedTimes(subEvent, minutes * MINUTE_MS, now);
  const started = subEventStatus(subEvent, now) !== 'upcoming';

  async function confirm(target: SubEvent) {
    if (busy || minutes === 0) return;
    const body = retry ? sent.body : delayedTimes(target, minutes * MINUTE_MS, new Date());
    setSent({ minutes, body });
    setBusy(true);
    setProblem(null);
    const failure = await writeSchedule(eventId, 'delay', () => updateSubEvent(target.id, body));
    setBusy(false);
    if (failure === null) {
      onClose();
      return;
    }
    setProblem(failure.message);
  }

  return (
    <View className="gap-5 px-4 pb-10 pt-6">
      <View className="flex-row items-start justify-between gap-3">
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          className="flex-1 font-h2 text-h2 text-textPrimary">
          Delay {subEvent.name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}
          onPress={onClose}>
          <Icon name="x" size={20} className="text-textSecondary" />
        </Pressable>
      </View>

      <View className="gap-2">
        <FieldLabel>Delay by</FieldLabel>
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
          {QUICK_MINUTES.map((amount) => {
            const selected = amount === minutes;
            return (
              <Pressable
                key={amount}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => setMinutes(amount)}
                className={`min-h-11 justify-center rounded-full border px-4 ${selected ? 'border-accent bg-accentTint' : 'border-borderStrong bg-surface active:bg-surfaceMuted'}`}>
                <Text
                  className={`font-fieldLabel text-fieldLabel ${selected ? 'text-accentText' : 'text-textPrimary'}`}>
                  {quickLabel(amount)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View className="flex-row items-center rounded-xl border border-border bg-surface px-2">
          <View
            pointerEvents="none"
            style={{ top: ((VISIBLE_ITEMS - 1) / 2) * ITEM_HEIGHT, height: ITEM_HEIGHT }}
            className="absolute inset-x-2 rounded-lg bg-textPrimary/5"
          />
          <View className="flex-1">
            <WheelPicker
              data={HOURS}
              value={Math.floor(minutes / 60)}
              onValueChanged={({ item }) => setMinutes(item.value * 60 + (minutes % 60))}
              itemHeight={ITEM_HEIGHT}
              visibleItemCount={VISIBLE_ITEMS}
              renderItem={renderItem}
              renderOverlay={null}
              enableScrollByTapOnItem
            />
          </View>
          <View className="flex-1">
            <WheelPicker
              data={MINUTES}
              value={minutes % 60}
              onValueChanged={({ item }) => setMinutes(Math.floor(minutes / 60) * 60 + item.value)}
              itemHeight={ITEM_HEIGHT}
              visibleItemCount={VISIBLE_ITEMS}
              renderItem={renderItem}
              renderOverlay={null}
              enableScrollByTapOnItem
            />
          </View>
        </View>
      </View>

      <View accessible className="gap-1 rounded-xl bg-surfaceMuted px-4 py-3">
        <Text className="font-micro text-micro uppercase tracking-wider text-textSecondary">
          New times
        </Text>
        <Text className="font-body text-body text-textPrimary">
          {minutes === 0
            ? 'Choose how long to delay it.'
            : formatSubEventTimes(new Date(next.startsAt), new Date(next.endsAt))}
        </Text>
        <Text className="font-caption text-caption text-textSecondary">
          {started
            ? 'It has started, so only the end moves.'
            : 'It has not started, so the start and the end both move.'}
        </Text>
      </View>

      {problem ? <FormMessage message={problem} /> : null}
      <Button
        label={retry && problem ? 'Try again' : 'Delay'}
        busy={busy}
        disabled={minutes === 0}
        onPress={() => void confirm(subEvent)}
      />
    </View>
  );
}
