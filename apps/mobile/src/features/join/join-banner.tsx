import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { ROLE_LABEL } from '@/features/events/event-card';
import { clearPendingInvite, usePendingInvite } from '@/features/join/pending-invite';

// The banner on signup and Login while an opened invite waits for an account: "Joining [Event
// Name] as Guest", so the reason for signing up shows before it happens (spec §2.3.1). The cross
// drops the invite, which is the dismissal D-115 keeps it until.
export function JoinBanner() {
  const invite = usePendingInvite();
  if (invite === null) {
    return null;
  }
  return (
    <View
      accessibilityLiveRegion="polite"
      className="flex-row items-start gap-3 rounded-2xl bg-accentTint py-3 pl-4 pr-1 ios:mx-5 android:mx-6">
      <View className="pt-0.5">
        <Icon name="ticket" size={20} className="text-accentText" />
      </View>
      <View className="flex-1 gap-0.5 py-0.5">
        <Text className="font-bodySecondary text-bodySecondary text-textPrimary">
          Joining <Text className="font-semibold">{invite.eventName}</Text> as{' '}
          {ROLE_LABEL[invite.role]}
        </Text>
        <Text className="font-caption text-caption text-textSecondary">
          Log in or create an account, then confirm the join.
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Don't join ${invite.eventName}`}
        onPress={clearPendingInvite}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-surface/50">
        <Icon name="x" size={18} className="text-textSecondary" />
      </Pressable>
    </View>
  );
}
