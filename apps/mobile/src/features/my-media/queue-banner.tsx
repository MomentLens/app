import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import type { QueueCounts } from '@/features/upload-queue/types';

export function QueueBanner({ counts }: { counts: QueueCounts }) {
  const [expanded, setExpanded] = useState(true);
  if (!counts.waiting && !counts.uploading) return null;
  const label = `${counts.waiting} waiting · ${counts.uploading} uploading`;
  return (
    <View className="mx-5 mb-4 overflow-hidden rounded-3xl ios:bg-surface android:mx-4 android:bg-surfaceContainer">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-14 flex-row items-center gap-3 px-5 py-4 active:opacity-80">
        <Icon name="clock" size={24} className="text-accentText" />
        <Text className="flex-1 font-h2 text-body text-textPrimary">{label}</Text>
        <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
          <Icon name="chevron-down" size={18} className="text-textSecondary" />
        </View>
      </Pressable>
      {expanded ? (
        <Text className="px-5 pb-5 font-bodySecondary text-bodySecondary text-textSecondary">
          Your queued photos stay on this phone until they upload.
        </Text>
      ) : null}
    </View>
  );
}
