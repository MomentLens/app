import { ActivityIndicator, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import type { LostAccess } from '@/features/event-shell/use-event';
import { byPlatform } from '@/lib/copy';

// Removed and blocked read alike, because the API answers both 403 not_member (spec §2.5.8). The
// queued photos stay stopped on the phone and upload if the membership is active again (spec §5.4,
// D-161).
const COPY: Record<LostAccess, { icon: IconName; title: string; body: string }> = {
  not_member: {
    icon: 'lock',
    title: 'You no longer have access',
    body: 'The organizer removed you from this event, so its photos and schedule are closed to you. Photos from this event still waiting on this phone stay here, and upload if you are let back in.',
  },
  not_found: {
    icon: 'link-2-off',
    title: 'This event is not available',
    body: 'It may have been deleted, or the link that opened it is wrong.',
  },
};

// Access Removed (spec §2.5.8), or the deleted-event state, in place of the Event shell's tabs once
// the API says the caller cannot see the event. It returns to Events and logs nobody out: only a
// dead session does that. A pending caller goes to Pending Approval instead (D-118).
export function NoAccess({ reason, onBack }: { reason: LostAccess; onBack: () => void }) {
  const copy = COPY[reason];
  return (
    <View className="flex-1 items-center justify-center gap-6 px-8 pb-10">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-textPrimary/5">
        <Icon name={copy.icon} size={28} className="text-textSecondary" />
      </View>
      <View className="w-full max-w-md items-center gap-3">
        <Text accessibilityRole="header" className="text-center font-h1 text-h1 text-textPrimary">
          {copy.title}
        </Text>
        <Text className="text-center font-body text-body text-textSecondary">{copy.body}</Text>
      </View>
      <Button label={byPlatform('Back to Events', 'Back to events')} onPress={onBack} />
    </View>
  );
}

// The event could not be loaded and nothing was cached to draw it from: offline on a first open,
// or the API failing.
export function LoadFailed({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6 pb-10">
      <Text accessibilityRole="header" className="text-center font-h2 text-h2 text-textPrimary">
        This event could not be loaded
      </Text>
      <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
        Check the connection and try again.
      </Text>
      <Button
        label={retrying ? 'Trying again' : byPlatform('Try Again', 'Try again')}
        variant="secondary"
        busy={retrying}
        onPress={onRetry}
      />
    </View>
  );
}

export function Loading() {
  return (
    <View className="flex-1 items-center justify-center pb-10">
      <ActivityIndicator className="text-textSecondary" />
    </View>
  );
}
