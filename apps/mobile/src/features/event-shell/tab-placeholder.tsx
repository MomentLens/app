import { Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';

interface TabPlaceholderProps {
  icon: IconName;
  title: string;
  body: string;
}

// A tab whose screen a later slice builds. The shell, its header and its tab bar are real; only the
// content waits.
export function TabPlaceholder({ icon, title, body }: TabPlaceholderProps) {
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-8 pb-10">
      <View className="h-16 w-16 items-center justify-center rounded-2xl bg-surfaceMuted">
        <Icon name={icon} size={28} className="text-textSecondary" />
      </View>
      <View className="w-full max-w-md items-center gap-2">
        <Text accessibilityRole="header" className="text-center font-h2 text-h2 text-textPrimary">
          {title}
        </Text>
        <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
          {body}
        </Text>
      </View>
    </View>
  );
}
