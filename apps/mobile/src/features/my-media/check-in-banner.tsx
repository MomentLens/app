import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Glyph } from '@/components/ui/glyph';
import { Icon } from '@/components/ui/icon';
import type { CheckInNotice } from '@/features/verification/notice';

interface Props {
  notice: CheckInNotice | null;
  location: { off: boolean; busy: boolean; error?: string; enable(): Promise<void> };
  onScan(): void;
}
export function CheckInBanner({ notice, location, onScan }: Props) {
  const [expanded, setExpanded] = useState(true);
  if (!notice) return null;
  const title = location.off
    ? 'Location is off'
    : notice.waitingPhotos
      ? `${notice.waitingPhotos} waiting to upload`
      : 'Check in for your photos';
  return (
    <View
      accessibilityLiveRegion="polite"
      className="mx-5 mb-4 gap-3 rounded-3xl px-5 py-4 ios:bg-surface android:mx-4 android:bg-surfaceContainer">
      {notice.liveNames.length ? (
        <View className="flex-row items-start gap-3">
          <View className="pt-1">
            <Glyph
              name={
                location.off
                  ? { ios: 'location.slash', android: 'location_off' }
                  : { ios: 'clock', android: 'schedule' }
              }
              size={24}
              tone="accentText"
            />
          </View>
          <View className="flex-1 gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={title}
              accessibilityState={{ expanded }}
              accessibilityHint="Show or hide check-in actions"
              onPress={() => setExpanded((value) => !value)}
              className="min-h-11 flex-row items-center gap-2">
              <Text className="flex-1 font-h2 text-body text-textPrimary">{title}</Text>
              <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
                <Icon name="chevron-down" size={16} className="text-textSecondary" />
              </View>
            </Pressable>
            {expanded ? (
              <>
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  {location.off
                    ? `MomentLens checks that you are at the venue before your photos upload.${notice.waitingPhotos ? ` ${notice.waitingPhotos} are waiting.` : ''}`
                    : `Checking that you are at ${notice.liveVenues.join(' or ')}. Your photos upload as soon as you check in.`}
                </Text>
                {location.off ? (
                  <View className="self-start">
                    <Button
                      label={Platform.OS === 'ios' ? 'Turn On Location' : 'Turn on location'}
                      icon="navigation"
                      busy={location.busy}
                      onPress={() => {
                        void location.enable();
                      }}
                    />
                  </View>
                ) : null}
                <View className="self-start">
                  <Button
                    label={Platform.OS === 'ios' ? 'Scan Venue QR' : 'Scan venue QR'}
                    icon="qr-code"
                    variant={Platform.OS === 'ios' ? 'secondary' : 'tonal'}
                    onPress={onScan}
                  />
                </View>
                {!location.off ? (
                  <Text className="pt-1 font-caption text-caption text-textSecondary">
                    Still waiting? Ask the organizer to check you in.
                  </Text>
                ) : null}
                {location.error ? (
                  <Text className="font-caption text-caption text-danger">{location.error}</Text>
                ) : null}
              </>
            ) : null}
          </View>
        </View>
      ) : null}
      {notice.localNames.length ? (
        <View className="gap-1">
          <Text className="font-h2 text-body text-textPrimary">Check-in saved on this phone</Text>
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
            For {notice.localNames.join(', ')}. MomentLens will confirm it with the next photo
            upload.
          </Text>
        </View>
      ) : null}
      {notice.endedPhotos ? (
        <View className="gap-1">
          <Text className="font-h2 text-body text-textPrimary">
            Ask the organizer to check you in.
          </Text>
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
            {notice.endedPhotos} {notice.endedPhotos === 1 ? 'photo is' : 'photos are'} waiting for
            a sub-event that has ended.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
