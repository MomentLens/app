import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { profilePhotoProblem } from '@/features/profile/photo-problem';
import { prepareProfilePhoto, uploadProfilePhoto } from '@/features/profile/profile-photo';
import { byPlatform } from '@/lib/copy';
import { choosePhotoSource, pickPhoto, type PhotoSource } from '@/lib/pick-photo';

const SIZE = 88;

// A photo picked and prepared on Create Account, not yet uploaded: the key needs the account's id,
// which exists only once signUp returns.
export interface SignupPhotoDraft {
  uri: string;
}

// Create Account's optional profile photo (spec §4.2, D-141), a circle above the fields. The photo
// goes through Stage 1 as soon as it is picked (D-172), so the upload after signUp has only the
// network left. It is the avatar and nothing more: no face check, no reference.
export function SignupPhoto({
  photo,
  onChange,
  disabled = false,
}: {
  photo: SignupPhotoDraft | null;
  onChange: (photo: SignupPhotoDraft | null) => void;
  disabled?: boolean;
}) {
  const [preparing, setPreparing] = useState(false);

  async function pick(source: PhotoSource) {
    let uri: string | null;
    try {
      uri = await pickPhoto(source);
    } catch {
      Alert.alert('The camera or photo picker could not open. Try again.');
      return;
    }
    if (uri === null) return;
    setPreparing(true);
    try {
      const jpeg = await prepareProfilePhoto(uri);
      onChange({ uri: jpeg.uri });
    } catch {
      Alert.alert('That photo could not be used. Try another one.');
    } finally {
      setPreparing(false);
    }
  }

  function choose() {
    choosePhotoSource(byPlatform('Profile Photo', 'Profile photo'), (source) => {
      void pick(source);
    });
  }

  return (
    <View className="items-center gap-2 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={photo ? 'Change profile photo' : 'Add a profile photo'}
        accessibilityHint="Optional"
        accessibilityState={{ busy: preparing, disabled: disabled || preparing }}
        disabled={disabled || preparing}
        onPress={choose}
        style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2 }}
        className="items-center justify-center overflow-hidden bg-surface active:opacity-80">
        {photo ? (
          <Image
            source={{ uri: photo.uri }}
            style={{ width: SIZE, height: SIZE }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
        ) : preparing ? null : (
          <Icon name="camera" size={28} className="text-accentText" />
        )}
        {preparing ? (
          <View className="absolute inset-0 items-center justify-center">
            <ActivityIndicator className="text-textSecondary" />
          </View>
        ) : null}
      </Pressable>
      <View className="flex-row gap-4">
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          suppressHighlighting
          onPress={disabled || preparing ? undefined : choose}
          className="font-fieldLabel text-bodySecondary text-accentText">
          {photo ? 'Change' : byPlatform('Add Photo', 'Add photo')}
        </Text>
        {photo ? (
          <Text
            accessibilityRole="button"
            accessibilityLabel="Remove profile photo"
            suppressHighlighting
            onPress={disabled ? undefined : () => onChange(null)}
            className="font-fieldLabel text-bodySecondary text-textSecondary">
            Remove
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// Runs after signUp returns a session. The signup screen is gone by then, so a failure is told in
// an alert, and the account stays: the person adds the photo from Profile (S-20 build, Ukasha).
export async function uploadSignupPhoto(owner: string, photo: SignupPhotoDraft): Promise<void> {
  try {
    await uploadProfilePhoto(owner, photo.uri);
  } catch (error) {
    Alert.alert('Your account is ready', `${profilePhotoProblem(error)} Add it from Profile.`);
  }
}
