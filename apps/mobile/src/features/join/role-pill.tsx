import type { InviteRole } from '@momentlens/shared-types';
import { Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';

const ROLE_ICON = { guest: 'user', photographer: 'camera' } as const;

// The role an invite joins as, pulled from which link was used (spec §2.3.1), with the sentence
// the screen needs: "You're joining as Guest", "Requested as Photographer".
export function RolePill({ role, label }: { role: InviteRole; label: string }) {
  return (
    <View className="flex-row items-center gap-1.5 self-start rounded-full bg-accentTint px-3 py-1.5">
      <Icon name={ROLE_ICON[role]} size={14} className="text-accentText" />
      <Text className="font-micro text-micro text-accentText">{label}</Text>
    </View>
  );
}
