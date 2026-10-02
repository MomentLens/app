import { Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';

interface TabPlaceholderProps {
  icon: IconName;
  title: string;
  body: string;
}

// A tab whose screen a later slice builds. The header and the tab bar are real; only the content
// waits.
export function TabPlaceholder({ icon, title, body }: TabPlaceholderProps) {
  return (
    <EventTabScreen>
      <View className="items-center gap-3 px-10 pt-24">
        <View className="mb-1 h-16 w-16 items-center justify-center rounded-full bg-textPrimary/5">
          <Icon name={icon} size={28} className="text-textSecondary" />
        </View>
        <Text accessibilityRole="header" className="text-center font-h2 text-h2 text-textPrimary">
          {title}
        </Text>
        <Text className="text-center font-body text-body text-textSecondary">{body}</Text>
      </View>
    </EventTabScreen>
  );
}
