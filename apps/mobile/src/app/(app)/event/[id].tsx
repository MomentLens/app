import { eventTiming } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/ui/app-header';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { RoleBadge } from '@/features/events/event-card';
import { formatEventDates } from '@/features/events/format';
import { useEvents } from '@/features/events/use-events';
import { presignedSource } from '@/lib/images';

const TIMING_LABEL = { active: 'Happening now', upcoming: 'Upcoming', past: 'Past' } as const;

// Where creating an event lands and where an Events card opens, until S-08 and S-13 build the
// event's Home. S-02 has no GET /events/{eventId} (D-110), so this reads the event from the list.
export default function EventPlaceholder() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const events = useEvents();
  const event = events.data?.events.find((candidate) => candidate.id === id);

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }}>
        <View className="px-4">
          <AppHeader left={{ icon: 'chevron-left', label: 'Events', onPress: back }} />
        </View>
        <ScrollView contentContainerClassName="flex-grow gap-5 px-4 pb-10 pt-4">
          {event ? (
            <>
              <View className="h-48 items-center justify-center overflow-hidden rounded-2xl bg-surfaceMuted">
                {event.cover ? (
                  <Image
                    source={presignedSource(event.cover)}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <Icon name="aperture" size={40} className="text-textMuted" />
                )}
              </View>
              <View className="gap-2">
                <Text accessibilityRole="header" className="font-h1 text-h1 text-textPrimary">
                  {event.name}
                </Text>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                    {formatEventDates(new Date(event.startsAt), new Date(event.endsAt))}
                  </Text>
                  <RoleBadge role={event.role} />
                  <Text className="font-caption text-caption text-textMuted">
                    {TIMING_LABEL[eventTiming(event, new Date())]}
                  </Text>
                </View>
              </View>
              <View className="gap-1 rounded-2xl border border-border bg-surface p-4">
                <Text className="font-fieldLabel text-fieldLabel text-textPrimary">
                  {event.role === 'admin' ? 'Your event is set up' : 'You are in'}
                </Text>
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  The event&apos;s home, with its album and schedule, is coming in a later update.
                </Text>
              </View>
            </>
          ) : events.isPending ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator className="text-accent" />
            </View>
          ) : events.isError ? (
            <View className="flex-1 items-center justify-center gap-4">
              <Text className="text-center font-h2 text-h2 text-textPrimary">
                This event could not be loaded
              </Text>
              <Button
                label={events.isFetching ? 'Trying again' : 'Try again'}
                variant="secondary"
                busy={events.isFetching}
                onPress={() => void events.refetch()}
              />
            </View>
          ) : (
            <View className="flex-1 items-center justify-center gap-2">
              <Text className="text-center font-h2 text-h2 text-textPrimary">
                This event is not available
              </Text>
              <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
                It may have been deleted, or you are no longer a member.
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
