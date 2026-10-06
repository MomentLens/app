import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { byPlatform } from '@/lib/copy';

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

// The album or the schedule its sections come from has never loaded, offline most often, since
// the album is not saved across a restart (D-148). "No photos yet" there would be a wrong answer.
export function AlbumLoadFailed({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <View className="items-center gap-4 px-8 py-16">
      <Text accessibilityRole="header" className="text-center font-h2 text-h2 text-textPrimary">
        The photos could not be loaded
      </Text>
      <Text className="text-center font-body text-body text-textSecondary">
        Check the connection and try again.
      </Text>
      <Button
        label={retrying ? 'Trying again' : byPlatform('Try Again', 'Try again')}
        variant="secondary"
        size="small"
        busy={retrying}
        onPress={onRetry}
      />
    </View>
  );
}
