import type { SubEvent } from '@momentlens/shared-types';
import { Text, View } from 'react-native';

// What My Media says in the camera's place while no sub-event is live (spec §2.5.4, D-136).
export function CameraHint({ schedule, now }: { schedule: readonly SubEvent[]; now: Date }) {
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
