import { useRouter } from 'expo-router';
import { Platform, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { SheetHandle } from '@/components/ui/sheet-toolbar';
import { useEvent } from '@/features/event-shell/use-event';
import { useSheetBottomPadding } from '@/features/schedule/sheet-inset';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useQueue } from '@/features/upload-queue/use-queue';
import { useHeldReadings } from './use-held-readings';

export function ScanResultScreen({ eventId, subEventId }: { eventId: string; subEventId: string }) {
  const router = useRouter();
  const bottom = useSheetBottomPadding();
  const event = useEvent(eventId);
  const subs = useSubEvents(eventId);
  const held = useHeldReadings(eventId);
  const queue = useQueue(eventId);
  const sub = subs.data?.subEvents.find((row) => row.id.toLowerCase() === subEventId.toLowerCase());
  const state = event.data?.verification;
  const confirmed =
    state?.everySubEvent ||
    state?.subEventIds.some((id) => id.toLowerCase() === subEventId.toLowerCase());
  const recorded = held.includes(subEventId.toLowerCase());
  const uploading = queue.items.filter(
    (row) => row.subEventId.toLowerCase() === subEventId.toLowerCase() && row.state === 'uploading',
  ).length;
  const title = confirmed
    ? "You're checked in"
    : recorded
      ? 'Check-in saved on this phone'
      : 'Checking your check-in';
  const done = () => router.dismissTo({ pathname: '/event/[id]/media', params: { id: eventId } });
  return (
    <View collapsable={false} className="bg-surface" style={{ paddingBottom: bottom }}>
      <SheetHandle />
      <View className="gap-5 px-6 pb-4 pt-6 ios:items-center">
        <View className="flex-row items-center gap-3 ios:flex-col">
          <View className="h-14 w-14 items-center justify-center rounded-full bg-accentTint ios:h-16 ios:w-16">
            <Glyph name={GLYPH.check} tone="accentText" size={28} />
          </View>
          <Text
            accessibilityRole="header"
            className="shrink font-h2 text-h2 text-textPrimary ios:text-center ios:font-h1 ios:text-h1">
            {title}
          </Text>
        </View>
        <Text
          accessibilityLiveRegion="polite"
          className="font-body text-body text-textSecondary ios:text-center">
          {sub ? `${sub.venue.name}, for ${sub.name}. ` : ''}
          {confirmed
            ? uploading
              ? `${uploading} ${uploading === 1 ? 'photo is' : 'photos are'} uploading.`
              : 'Your photos can upload when the connection and album allow it.'
            : recorded
              ? 'Your photos are ready for upload. MomentLens will confirm the code with the next photo upload.'
              : 'Return to My Media for the latest result. If photos still need a check-in, scan the current venue code or ask the organizer.'}
        </Text>
        <View className={Platform.OS === 'ios' ? 'w-full' : 'self-end'}>
          <Button label="Done" onPress={done} />
        </View>
      </View>
    </View>
  );
}
