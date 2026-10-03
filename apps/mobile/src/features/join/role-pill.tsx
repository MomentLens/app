import type { InviteRole } from '@momentlens/shared-types';
import { Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';

const ROLE_ICON = { guest: 'user', photographer: 'camera' } as const;

// The role an invite joins as, pulled from which link was used (spec §2.3.1), with the sentence
// the screen needs: "You're joining as Guest", "Requested as Photographer". Neutral, at full text
// contrast, since gold marks the brand and the main action only (D-124).
export function RolePill({ role, label }: { role: InviteRole; label: string }) {
  return (
    <View className="flex-row items-center gap-1.5 self-start rounded-full bg-textPrimary/[0.07] px-3 py-1.5">
      <Icon name={ROLE_ICON[role]} size={15} className="text-textSecondary" />
      <Text className="font-fieldLabel text-caption text-textPrimary">{label}</Text>
    </View>
  );
}
