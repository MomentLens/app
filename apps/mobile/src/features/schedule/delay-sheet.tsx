import { subEventStatus, type SubEvent } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { formatSubEventTimes } from '@/features/events/format';
import { delayedTimes, nextStatusChange } from '@/features/schedule/schedule';
import { DurationPicker } from '@/features/schedule/duration-picker';
import { useSheetBottomPadding } from '@/features/schedule/sheet-inset';
import { useSubEvents, writeSchedule } from '@/features/schedule/use-sub-events';
import { useNow } from '@/hooks/use-now';
import { updateSubEvent } from '@/lib/api';

const MINUTE_MS = 60 * 1000;

// The amounts a late sub-event most often needs, one tap each, then Custom, which takes any other
// up to a day less five minutes. A bigger move is an edit of the times (spec §4.3).
type Choice = 15 | 30 | 60 | 120 | 'custom';
const CHOICES = [
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 60, label: '1h' },
  { value: 120, label: '2h' },
  { value: 'custom', label: 'Custom' },
] as const satisfies readonly { value: Choice; label: string }[];

// An amount as the button says it: "30 min", "1 hr", "1 hr 45 min".
function amountLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

interface DelaySheetProps {
  eventId: string;
  subEventId: string;
}

// The Admin's Delay (spec §2.5.5, D-121, D-127), a sheet over the whole Event shell: a positive
// amount from the platform's segmented control, or a custom one from the platform's picker,
// turned into new absolute times and sent through the edit endpoint. One button does two things
// depending on the clock, so the sheet shows the old times struck through beside the new ones, and
// names the amount on the button, before anything is sent.
export function DelaySheet({ eventId, subEventId }: DelaySheetProps) {
  const router = useRouter();
  const bottom = useSheetBottomPadding();
  const subEvents = useSubEvents(eventId).data?.subEvents;
  // Moves on at the sub-event's start, so the preview switches to moving the end alone.
  const now = useNow(
    useCallback((at: Date) => (subEvents ? nextStatusChange(subEvents, at) : null), [subEvents]),
  );
  const onClose = () => router.back();
  const subEvent = subEvents?.find((candidate) => candidate.id === subEventId);
  const [choice, setChoice] = useState<Choice>(30);
  const [custom, setCustom] = useState(45);
  const minutes = choice === 'custom' ? custom : choice;
  // The body last sent, kept so that trying again after a failure sends exactly the same times,
  // even if the cached schedule has since caught up with a first attempt that did land.
  const [sent, setSent] = useState<{ minutes: number; body: ReturnType<typeof delayedTimes> }>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (subEvents === undefined) {
    return (
      <View className="items-center bg-background py-10" style={{ paddingBottom: bottom }}>
        <ActivityIndicator className="text-textSecondary" />
      </View>
    );
  }
  if (subEvent === undefined) {
    return (
      <View collapsable={false} className="gap-4 bg-background" style={{ paddingBottom: bottom }}>
        <SheetHandle />
        <SheetToolbar onClose={onClose} />
        <View className="gap-2 px-5">
          <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
            This sub-event is gone
          </Text>
          <Text className="font-body text-body text-textSecondary">
            It was deleted on another phone.
          </Text>
        </View>
      </View>
    );
  }

  const retry = sent !== undefined && sent.minutes === minutes;
  const next = retry ? sent.body : delayedTimes(subEvent, minutes * MINUTE_MS, now);
  const started = subEventStatus(subEvent, now) !== 'upcoming';
  const before = formatSubEventTimes(new Date(subEvent.startsAt), new Date(subEvent.endsAt));
  const after = formatSubEventTimes(new Date(next.startsAt), new Date(next.endsAt));

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

  // One view that never flattens away. A native sheet that holds a scroll view, as each wheel is,
  // lays out its direct children itself, and with this view flattened it took a wheel out of its
  // box (react-native-screens).
  return (
    <View collapsable={false} className="gap-4 bg-background" style={{ paddingBottom: bottom }}>
      <SheetHandle />
      <SheetToolbar title={`Delay ${subEvent.name}`} onClose={onClose} />
      <View className="gap-5 ios:px-5 android:px-6">
        <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
          Now {before}
        </Text>
        <Segmented
          accessibilityLabel="Delay by"
          options={CHOICES}
          value={choice}
          onChange={setChoice}
        />
        {choice === 'custom' ? <DurationPicker minutes={custom} onChange={setCustom} /> : null}

        <View accessible className="gap-1.5 rounded-2xl bg-surface px-4 py-3.5">
          <Text className="font-caption text-caption text-textSecondary">New times</Text>
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary line-through">
            {before}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <Icon name="chevron-right" size={16} className="text-textSecondary" />
            <Text className="flex-1 font-h2 text-body text-textPrimary">
              {minutes === 0 ? 'Choose how long to delay it.' : after}
            </Text>
          </View>
          <Text className="font-caption text-caption text-textSecondary">
            {started
              ? `${subEvent.name} has started, so only the end moves.`
              : `${subEvent.name} hasn't started, so the start and the end both move.`}
          </Text>
        </View>

        {problem ? <FormMessage message={problem} /> : null}
        <Button
          label={retry && problem ? 'Try again' : `Delay ${amountLabel(minutes)}`}
          busy={busy}
          disabled={minutes === 0}
          onPress={() => void confirm(subEvent)}
        />
      </View>
    </View>
  );
}
