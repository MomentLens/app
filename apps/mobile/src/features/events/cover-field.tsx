import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { prepareCover } from '@/features/events/cover';
import type { DraftCover } from '@/features/events/draft';
import { FieldError } from '@/features/events/wizard-frame';
import { useTokenColor } from '@/hooks/use-token-color';
import { byPlatform } from '@/lib/copy';

interface CoverFieldProps {
  cover: DraftCover | null;
  onChange: (cover: DraftCover | null) => void;
}

// A small pill over the photo, on a dark shade so it reads on any cover.
function PhotoPill({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} cover photo`}
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
// uploads once the event exists, because its key carries the event's id (arch §3).
export function CoverField({ cover, onChange }: CoverFieldProps) {
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const ripple = useTokenColor('textPrimary', 0.08);

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
    try {
      onChange(await prepareCover(asset.uri));
    } catch {
      setProblem('That photo could not be used. Try another one.');
    } finally {
      setPreparing(false);
    }
  }

  return (
    <View className="gap-1.5 ios:mx-5 android:mx-4">
      {cover ? (
        <View className="h-44 overflow-hidden bg-surfaceMuted ios:rounded-[26px] android:rounded-3xl">
          <Image
            source={{ uri: cover.uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
          <View className="absolute right-3 top-3 flex-row gap-2">
            <PhotoPill label="Remove" onPress={() => onChange(null)} />
            <PhotoPill label="Change" onPress={() => void pick()} disabled={preparing} />
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a cover photo"
          accessibilityHint="Optional. Guests see it on the invite."
          accessibilityState={{ busy: preparing }}
          disabled={preparing}
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
