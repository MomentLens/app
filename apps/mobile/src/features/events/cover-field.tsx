import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { prepareCover } from '@/features/events/cover';
import type { DraftCover } from '@/features/events/draft';
import { FieldError, FieldLabel } from '@/features/events/wizard-frame';

interface CoverFieldProps {
  cover: DraftCover | null;
  onChange: (cover: DraftCover | null) => void;
}

// Step 1's optional cover (spec §2.1.2). The photo is only prepared here; it uploads once the
// event exists, because its key carries the event's id (arch §3).
export function CoverField({ cover, onChange }: CoverFieldProps) {
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

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
    <View className="gap-2">
      <FieldLabel>Cover photo</FieldLabel>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={cover ? 'Change cover photo' : 'Add cover photo'}
        accessibilityState={{ busy: preparing }}
        disabled={preparing}
        onPress={() => void pick()}
        className="h-40 items-center justify-center gap-2 overflow-hidden rounded-xl bg-surface active:bg-surfaceMuted">
        {/* The dashed outline is a view of its own that comes and goes. Dropping a dashed border
            from the box itself once a photo was picked left the photo undrawn on Android, while
            the same photo showed everywhere else. */}
        {cover ? null : (
          <View
            pointerEvents="none"
            className="absolute inset-0 rounded-xl border border-dashed border-borderStrong"
          />
        )}
        {cover ? (
          <Image
            source={{ uri: cover.uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
        ) : preparing ? (
          <ActivityIndicator className="text-accent" />
        ) : (
          <>
            <View className="h-10 w-10 items-center justify-center rounded-full bg-surfaceMuted">
              <Icon name="camera" size={18} className="text-textSecondary" />
            </View>
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              Add cover photo
            </Text>
          </>
        )}
      </Pressable>
      {cover ? (
        <View className="flex-row gap-2">
          <CoverAction
            label="Change"
            accessibilityLabel="Change cover photo"
            onPress={() => void pick()}
            disabled={preparing}
          />
          <CoverAction
            label="Remove"
            accessibilityLabel="Remove cover photo"
            tone="muted"
            onPress={() => onChange(null)}
          />
        </View>
      ) : null}
      <FieldError message={problem} />
    </View>
  );
}

interface CoverActionProps {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  tone?: 'accent' | 'muted';
  disabled?: boolean;
}

// Change and Remove under the photo. They read as links, like TextLink, but stand on their own, so
// each gets a full target: 44pt tall on iOS, 48dp on Android (D-112). TextLink stays a Text so it
// can sit inside a sentence, and a Text has no hit slop.
function CoverAction({
  label,
  accessibilityLabel,
  onPress,
  tone = 'accent',
  disabled = false,
}: CoverActionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`justify-center px-2 ios:min-h-11 android:min-h-12 ${disabled ? 'opacity-60' : ''}`}>
      <Text
        className={`font-caption text-caption underline ${tone === 'accent' ? 'text-accentText' : 'text-textSecondary'}`}>
        {label}
      </Text>
    </Pressable>
  );
}
