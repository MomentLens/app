import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glyph } from '@/components/ui/glyph';
import { BottomTabInset } from '@/lib/platform';

export function CameraEntry({
  eventId,
  schedule,
  now,
  line = false,
}: {
  eventId: string;
  schedule: readonly SubEvent[];
  now: Date;
  line?: boolean;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const live = currentSubEvent(schedule, now);
  if (line) {
    if (live) return null;
    const next = schedule
      .filter((sub) => Date.parse(sub.startsAt) > now.getTime())
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
    return (
      <View className="px-5 pb-4 android:px-4">
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          {next
            ? `The camera opens at ${new Date(next.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}, for ${next.name}.`
            : schedule.length
              ? 'The event has ended. Use Add Media to add photos from your gallery.'
              : 'The camera opens when a sub-event is live.'}
        </Text>
      </View>
    );
  }
  if (!live) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open camera for ${live.name}`}
      className="absolute right-5 h-14 w-14 items-center justify-center rounded-full bg-accent ios:shadow-md android:rounded-2xl"
      style={{ bottom: insets.bottom + BottomTabInset + 16 }}
      onPress={() => router.push({ pathname: '/capture/[eventId]', params: { eventId } })}>
      <Glyph name={{ ios: 'camera.fill', android: 'photo_camera' }} tone="scrim" size={26} />
    </Pressable>
  );
}
