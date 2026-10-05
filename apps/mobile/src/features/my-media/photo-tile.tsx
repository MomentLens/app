import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import type { MenuAnchor } from '@/components/ui/anchored-menu';
import { Glyph, GLYPH } from '@/components/ui/glyph';
import { Icon } from '@/components/ui/icon';
import { canDeleteLocally, tileStatus } from './sections';
import type { QueueItem } from '@/features/upload-queue/types';

export function PhotoTile({
  item,
  eventId,
  onDelete,
  onMenu,
  removed,
}: {
  item: QueueItem;
  eventId: string;
  onDelete: () => void;
  onMenu: (anchor: MenuAnchor) => void;
  removed: boolean;
}) {
  const ref = useRef<View>(null);
  const status = tileStatus(item);
  const deletable = canDeleteLocally(item, removed);
  const tile = (
    <Pressable
      ref={ref}
      style={{ flex: 1, aspectRatio: 1 }}
      accessibilityRole={deletable ? 'button' : 'image'}
      accessibilityLabel={`Photo, ${status.label}`}
      accessibilityHint={deletable ? 'Hold to delete the local copy.' : undefined}
      accessibilityActions={deletable ? [{ name: 'delete', label: 'Delete local photo' }] : []}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'delete') onDelete();
      }}
      onLongPress={
        Platform.OS !== 'ios' && deletable
          ? () =>
              ref.current?.measureInWindow((x, y, width, height) => onMenu({ x, y, width, height }))
          : undefined
      }
      className="overflow-hidden bg-surfaceMuted">
      <Image
        source={{ uri: item.thumbnailUri }}
        cachePolicy="none"
        contentFit="cover"
        recyclingKey={`${item.userId}/${item.id}`}
        style={{ width: '100%', height: '100%' }}
      />
      {status.kind === 'reason' ? (
        <View className="absolute bottom-0 left-0 right-0 bg-scrim/75 px-2 py-2">
          <Text className="font-caption text-caption text-onPhoto">{status.label}</Text>
        </View>
      ) : (
        <View
          className={`absolute bottom-2 right-2 h-7 w-7 items-center justify-center rounded-full border border-onPhoto/60 ${status.kind === 'check' ? 'bg-success' : 'bg-scrim/60'}`}>
          {status.kind === 'spinner' ? (
            <ActivityIndicator size="small" className="text-onPhoto" />
          ) : status.kind === 'phone' ? (
            <Glyph name={{ ios: 'iphone', android: 'smartphone' }} size={17} tone="onPhoto" />
          ) : (
            <Icon
              name={status.kind === 'check' ? 'check' : 'clock'}
              size={17}
              className="text-onPhoto"
            />
          )}
        </View>
      )}
    </Pressable>
  );
  if (Platform.OS !== 'ios' || !deletable) return tile;
  // UIKit's context menu comes from Link.Menu (D-127). No Link.Preview: with one, expo-router
  // preloads the href when the menu opens and navigates to it when the preview is tapped, and this
  // href is the screen already showing. The tap itself goes nowhere.
  return (
    <Link
      href={{ pathname: '/event/[id]/media', params: { id: eventId } }}
      asChild
      onPress={(event) => event.preventDefault()}>
      <Link.Trigger>{tile}</Link.Trigger>
      <Link.Menu>
        <Link.MenuAction title="Delete" icon={GLYPH.trash.ios} destructive onPress={onDelete} />
      </Link.Menu>
    </Link>
  );
}
