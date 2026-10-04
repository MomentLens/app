import type { PresignedImage } from '@momentlens/shared-types';
import { Image, type ImageSource } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { prepareCover } from '@/features/events/cover';
import type { DraftCover } from '@/features/events/draft';
import { FieldError } from '@/features/events/wizard-frame';
import { useTokenColor } from '@/hooks/use-token-color';
import { byPlatform } from '@/lib/copy';
import { presignedSource } from '@/lib/images';

interface CoverFieldProps {
  // A photo picked on this phone and prepared, not yet uploaded.
  cover: DraftCover | null;
  onChange: (cover: DraftCover | null) => void;
  // Event Settings: the cover the event already has, shown until another photo is picked. A saved
  // cover is replaced, never removed, so it gets Change and no Remove (D-114). A picked photo over
  // it gets Undo, which shows the saved one again. The wizard leaves it out.
  saved?: PresignedImage | null;
  disabled?: boolean;
  // Told when a picked photo starts and stops being prepared, so a form can hold its Save until
  // the photo is ready rather than save without it.
  onPreparingChange?: (preparing: boolean) => void;
}

// A small pill over the photo, on a dark shade so it reads on any cover.
function PhotoPill({
  label,
  accessibilityLabel = `${label} cover photo`,
  onPress,
  disabled = false,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      className={`min-h-9 justify-center rounded-full bg-scrim/45 px-3.5 active:opacity-80 ${disabled ? 'opacity-60' : ''}`}>
      <Text className="font-fieldLabel text-bodySecondary text-onPhoto">{label}</Text>
    </Pressable>
  );
}

// Step 1's optional cover (spec §2.1.2), as a well at the top of the form: the photo the width of
// the page once picked, with Change and Remove over it (D-124). The photo is only prepared here; it
// uploads once the event exists, because its key carries the event's id (arch §3). Event Settings
// shows the saved cover in the same well and uploads a picked one on Save (D-142).
export function CoverField({
  cover,
  onChange,
  saved,
  disabled = false,
  onPreparingChange,
}: CoverFieldProps) {
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const ripple = useTokenColor('textPrimary', 0.08);
  // Only a picked photo can be taken back. Over a saved cover that is Undo, since the saved one
  // stays; anywhere else it is Remove, and the well is empty again.
  const clearLabel = cover === null ? null : saved ? 'Undo' : 'Remove';
  // The saved cover is cached under the key the API returned, never its URL (root invariant 2).
  const source: ImageSource | null = cover
    ? { uri: cover.uri }
    : saved
      ? presignedSource(saved)
      : null;

  async function pick() {
    setProblem(undefined);
    // The system photo picker needs no library permission on either platform.
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 1,
      exif: false,
      selectionLimit: 1,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return;
    setPreparing(true);
    onPreparingChange?.(true);
    try {
      onChange(await prepareCover(asset.uri));
    } catch {
      setProblem('That photo could not be used. Try another one.');
    } finally {
      setPreparing(false);
      onPreparingChange?.(false);
    }
  }

  return (
    <View className="gap-1.5 ios:mx-5 android:mx-4">
      {source ? (
        <View className="h-44 overflow-hidden bg-surfaceMuted ios:rounded-[26px] android:rounded-3xl">
          <Image
            source={source}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
          <View className="absolute right-3 top-3 flex-row gap-2">
            {clearLabel ? (
              <PhotoPill
                label={clearLabel}
                accessibilityLabel={clearLabel === 'Undo' ? 'Undo the new cover photo' : undefined}
                onPress={() => onChange(null)}
                disabled={disabled}
              />
            ) : null}
            <PhotoPill
              label="Change"
              onPress={() => void pick()}
              disabled={preparing || disabled}
            />
          </View>
          {preparing ? (
            <View className="absolute inset-0 items-center justify-center bg-scrim/45">
              <ActivityIndicator className="text-onPhoto" />
            </View>
          ) : null}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a cover photo"
          accessibilityHint="Optional. Guests see it on the invite."
          accessibilityState={{ busy: preparing, disabled }}
          disabled={preparing || disabled}
          onPress={() => void pick()}
          android_ripple={{ color: ripple }}
          className="h-44 items-center justify-center gap-2 overflow-hidden bg-surface ios:rounded-[26px] ios:active:bg-surfaceMuted android:rounded-3xl">
          {preparing ? (
            <ActivityIndicator className="text-textSecondary" />
          ) : (
            <>
              <Icon name="camera" size={26} className="text-accentText" />
              <Text className="font-h2 text-body text-accentText">
                {byPlatform('Add Cover Photo', 'Add cover photo')}
              </Text>
              <Text className="font-caption text-caption text-textSecondary">
                Optional. Guests see it on the invite.
              </Text>
            </>
          )}
        </Pressable>
      )}
      <FieldError message={problem} />
    </View>
  );
}
