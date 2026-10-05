import { Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';

interface EmptyStateProps {
  title: string;
  body: string;
}

function BaseEmpty({ title, body }: EmptyStateProps) {
  return (
    <View className="items-center justify-center px-6 py-16 text-center">
      <View className="mb-4 h-12 w-12 items-center justify-center rounded-full bg-surfaceElevated">
        <Icon name="images" size={24} className="text-textSecondary" />
      </View>
      <Text
        accessibilityRole="header"
        className="mb-1 text-center font-h2 text-h2 text-textPrimary">
        {title}
      </Text>
      <Text className="text-center font-body text-body text-textSecondary">{body}</Text>
    </View>
  );
}

export function AllEmpty() {
  return (
    <BaseEmpty
      title="No photos yet"
      body="Photos will appear here as guests and photographers upload."
    />
  );
}

export function SubEventEmpty({ subEventName }: { subEventName: string }) {
  return (
    <BaseEmpty
      title={`No photos from ${subEventName} yet`}
      body="Photos taken during this sub-event will appear here once published."
    />
  );
}

export function UploaderEmpty({ uploaderName }: { uploaderName: string }) {
  return (
    <BaseEmpty
      title={`No photos from ${uploaderName} yet`}
      body="Photos uploaded by this contributor will appear here."
    />
  );
}
