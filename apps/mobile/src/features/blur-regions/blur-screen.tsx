import type { BlurRegion } from '@momentlens/shared-types';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { BlurEditor, NO_DRAFT } from '@/features/blur-regions/blur-editor';
import { toFractions, type PointRect, type Size } from '@/features/blur-regions/geometry';
import {
  useAlbumItem,
  useBlurEditing,
  useBlurRegions,
  useFullImage,
  type PendingRegion,
} from '@/features/blur-regions/use-blur-regions';
import { tabHref } from '@/features/event-shell/tabs';
import { useEvent } from '@/features/event-shell/use-event';
import { ApiError } from '@/lib/api';

const IOS = Platform.OS === 'ios';

// Blur an Area (spec §4.11.4.4, design 18 frame 04). A Guest or the Admin drags a rectangle over a
// face the detector missed and presses Blur. The rectangle draws solid at once and the API stores
// it and enqueues blur_region; every viewer sees the previous file until that job finishes
// (D-170). The person's own regions, or every region for the Admin, draw solid too, and a tap on
// one removes it after a confirm.
export function BlurScreen({ eventId, mediaId }: { eventId: string; mediaId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const event = useEvent(eventId).data?.event;
  const isAdmin = event?.role === 'admin';

  const item = useAlbumItem(eventId, mediaId);
  const image = useFullImage(eventId, mediaId, item?.variantVersion);
  const regions = useBlurRegions(eventId, mediaId);
  const editing = useBlurEditing(eventId, mediaId);

  const draft = useSharedValue<PointRect>(NO_DRAFT);
  const frame = useRef<Size>({ width: 0, height: 0 });
  const [hasDraft, setHasDraft] = useState(false);
  const onFrame = useCallback((size: Size) => {
    frame.current = size;
  }, []);

  const saved = useMemo(
    () => (regions.data?.regions ?? []).filter((region) => !editing.removing.has(region.id)),
    [regions.data, editing.removing],
  );
  const failedCount = editing.pending.filter((region) => region.failed).length;

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace(tabHref(eventId, 'home'));
  }

  function leave() {
    if (failedCount === 0) return close();
    Alert.alert(
      failedCount === 1 ? 'One blur was not saved' : `${failedCount} blurs were not saved`,
      'If you leave now, these areas stay visible to everyone.',
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: close },
      ],
    );
  }

  function blur() {
    const rect = toFractions(draft.get(), frame.current);
    draft.set(NO_DRAFT);
    setHasDraft(false);
    if (rect) editing.add(rect);
  }

  function askToRemove(region: BlurRegion) {
    const whoDrew = isAdmin ? `Drawn by ${region.drawnBy.fullName}. ` : '';
    Alert.alert(
      'Remove this blur?',
      `${whoDrew}Everyone at this event sees this area again once the photo updates.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void editing.remove(region).then((result) => {
              if (result === 'failed')
                Alert.alert('Could not remove the blur', 'Check your connection and try again.');
            });
          },
        },
      ],
    );
  }

  function askAboutFailed(region: PendingRegion) {
    if (!region.failed) return;
    Alert.alert('This blur was not saved', 'Check your connection and try again.', [
      { text: 'Discard', style: 'destructive', onPress: () => editing.discard(region.id) },
      { text: 'Try Again', onPress: () => void editing.retry(region) },
    ]);
  }

  const refusedStatus = (error: unknown) => (error instanceof ApiError ? error.status : undefined);
  const gone =
    editing.problem === 'photo_gone' ||
    image.data === null ||
    refusedStatus(image.error) === 404 ||
    refusedStatus(regions.error) === 404;
  const noAccess =
    editing.problem === 'no_access' ||
    event?.role === 'photographer' ||
    refusedStatus(image.error) === 403 ||
    refusedStatus(regions.error) === 403;

  let body;
  if (gone || noAccess) {
    body = (
      <Message
        title={gone ? 'This photo is no longer in the album' : 'You can’t blur areas of this photo'}
        detail={
          gone
            ? 'It was deleted or is being processed again.'
            : 'Only Guests and the organizer can blur part of a photo.'
        }
        onClose={close}
      />
    );
  } else if (image.isError || regions.isError) {
    body = (
      <Message
        title="Could not load the photo"
        detail="Check your connection and try again."
        onClose={close}
        onRetry={() => {
          void image.refetch();
          void regions.refetch();
        }}
      />
    );
  } else if (!image.data || !regions.data) {
    body = <ActivityIndicator className="mt-24 text-onPhoto" />;
  } else {
    body = (
      <>
        <BlurEditor
          image={image.data}
          imageSize={
            item?.width && item.height ? { width: item.width, height: item.height } : undefined
          }
          saved={saved}
          pending={editing.pending}
          draft={draft}
          onFrame={onFrame}
          onDraftChange={setHasDraft}
          onPressSaved={askToRemove}
          onPressPending={askAboutFailed}
        />
        <View className="px-8 pt-5" style={{ paddingBottom: insets.bottom + 16 }}>
          <Text className="text-center font-bodySecondary text-bodySecondary text-onPhoto/70">
            Drag to cover a face or anything that shouldn’t be shared. It blurs for everyone at this
            event. Tap a blurred area to remove it.
          </Text>
        </View>
      </>
    );
  }

  const ready = !!image.data && !!regions.data && !gone && !noAccess;
  const title = IOS ? 'Blur an Area' : 'Blur an area';
  return (
    <View className="flex-1 bg-scrim" style={{ paddingTop: insets.top }}>
      <StatusBar style="light" />
      <View className="h-16 flex-row items-center gap-3 px-4 android:pl-1">
        {IOS ? (
          <GlassButton label={hasDraft ? 'Cancel' : 'Done'} onPress={leave} wide>
            <Text className="font-body text-body text-onPhoto">{hasDraft ? 'Cancel' : 'Done'}</Text>
          </GlassButton>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={leave}
            className="h-12 w-12 items-center justify-center">
            <Glyph name={GLYPH.close} tone="onPhoto" />
          </Pressable>
        )}
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          className={`flex-1 font-h2 text-h2 text-onPhoto ${IOS ? 'text-center' : ''}`}>
          {title}
        </Text>
        <PhotoButton
          label="Blur"
          small
          disabled={!ready || !hasDraft}
          onPress={blur}
          hint={hasDraft ? undefined : 'Drag on the photo first'}
        />
      </View>
      {body}
    </View>
  );
}

function Message({
  title,
  detail,
  onClose,
  onRetry,
}: {
  title: string;
  detail: string;
  onClose: () => void;
  onRetry?: () => void;
}) {
  return (
    <View className="gap-4 px-8 pt-16">
      <Text className="font-h2 text-h2 text-onPhoto">{title}</Text>
      <Text className="font-body text-body text-onPhoto/80">{detail}</Text>
      {onRetry ? <PhotoButton label="Try Again" onPress={onRetry} /> : null}
      <PhotoButton label="Close" quiet={!!onRetry} onPress={onClose} />
    </View>
  );
}

// This screen is black in light and dark mode alike, so its buttons use the photo tokens rather
// than Button, whose disabled and secondary looks are drawn for the page background.
function PhotoButton({
  label,
  onPress,
  disabled = false,
  small = false,
  quiet = false,
  hint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  small?: boolean;
  quiet?: boolean;
  hint?: string;
}) {
  const fill = disabled ? 'bg-onPhoto/15' : quiet ? 'bg-onPhoto/15' : 'bg-accent';
  const tone = disabled ? 'text-onPhoto/40' : quiet ? 'text-onPhoto' : 'text-scrim';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`items-center justify-center rounded-full active:opacity-70 ${fill} ${
        small ? 'ios:min-h-11 android:min-h-10 px-5' : 'ios:min-h-[50px] android:min-h-14 px-6'
      }`}>
      <Text
        className={`font-buttonLabel ${small ? 'text-bodySecondary' : 'text-buttonLabel'} ${tone}`}>
        {label}
      </Text>
    </Pressable>
  );
}
