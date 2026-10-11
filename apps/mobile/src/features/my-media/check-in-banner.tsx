import { Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import type { CheckInNotice } from '@/features/verification/notice';

export function CheckInBanner({ notice }: { notice: CheckInNotice | null }) {
  if (!notice) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      className="mx-5 mb-4 gap-3 rounded-3xl px-5 py-4 ios:bg-surface android:mx-4 android:bg-surfaceContainer">
      {notice.liveNames.length ? (
        <View className="flex-row items-start gap-3">
          <Icon name="map-pin" size={24} className="text-accentText" />
          <View className="flex-1 gap-1">
            <Text className="font-h2 text-body text-textPrimary">
              Check in for {notice.liveNames.join(', ')}
            </Text>
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              Keep MomentLens open at the venue for the location check. Your photos stay on this
              phone until you check in.
            </Text>
          </View>
        </View>
      ) : null}
      {notice.endedPhotos ? (
        <View className="flex-row items-start gap-3">
          <Icon name="clock" size={24} className="text-accentText" />
          <View className="flex-1 gap-1">
            <Text className="font-h2 text-body text-textPrimary">
              Ask the organizer to check you in.
            </Text>
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              {notice.endedPhotos} {notice.endedPhotos === 1 ? 'photo is' : 'photos are'} waiting
              for a sub-event that has ended.
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
