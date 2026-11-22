import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';

import { Avatar } from '@/components/ui/avatar';
import { Row, Section, SectionGap } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { LargeTitleScreen } from '@/components/ui/large-title-screen';
import { logout } from '@/features/auth/logout';
import { useAccountEmail } from '@/features/auth/use-account-email';
import { profilePhotoProblem } from '@/features/profile/photo-problem';
import { prepareProfilePhoto, uploadProfilePhoto } from '@/features/profile/profile-photo';
import { useMyProfile } from '@/hooks/use-my-profile';
import { byPlatform } from '@/lib/copy';
import { choosePhotoSource, pickPhoto, type PhotoSource } from '@/lib/pick-photo';
import { useAuthStore } from '@/stores/auth';

const AVATAR_SIZE = 52;

// The Profile tab (spec §4.19): who is signed in, their profile photo, and Log Out. Account
// Settings' grouped rows, Do Not Publish among them, arrive with S-29 in spec §4.19's order
// (spec §2.5.9). The photo is the avatar only, never a reference photo (D-141).
export default function ProfileTab() {
  const profile = useMyProfile();
  const email = useAccountEmail();
  const owner = useAuthStore((state) => state.userId);
  const [loggingOut, setLoggingOut] = useState(false);
  const [settingPhoto, setSettingPhoto] = useState(false);

  async function setPhoto(source: PhotoSource) {
    if (owner === null) return;
    let uri: string | null;
    try {
      uri = await pickPhoto(source);
    } catch {
      Alert.alert('The camera or photo picker could not open. Try again.');
      return;
    }
    if (uri === null) return;
    setSettingPhoto(true);
    try {
      const jpeg = await prepareProfilePhoto(uri);
      await uploadProfilePhoto(owner, jpeg.uri);
    } catch (error) {
      Alert.alert(profilePhotoProblem(error));
    } finally {
      setSettingPhoto(false);
    }
  }

  function changePhoto() {
    choosePhotoSource(byPlatform('Profile Photo', 'Profile photo'), (source) => {
      void setPhoto(source);
    });
  }

  async function logOut() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      // Normally this screen is gone by now, because logging out closes the signed-in group.
      setLoggingOut(false);
    }
  }

  // Logging out is a slip away on a row this size, so it asks first.
  function confirmLogOut() {
    Alert.alert(byPlatform('Log Out?', 'Log out?'), undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: byPlatform('Log Out', 'Log out'),
        style: 'destructive',
        onPress: () => void logOut(),
      },
    ]);
  }

  return (
    <LargeTitleScreen title="Profile">
      <Section>
        {profile.status === 'error' ? (
          <Row
            title="Your profile could not be loaded"
            subtitle={profile.isFetching ? 'Trying again' : 'Tap to try again'}
            onPress={() => void profile.refetch()}
          />
        ) : (
          <Row
            leading={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={byPlatform('Change Profile Photo', 'Change profile photo')}
                accessibilityState={{ busy: settingPhoto, disabled: settingPhoto }}
                disabled={settingPhoto || profile.status !== 'success'}
                hitSlop={6}
                onPress={changePhoto}
                className="active:opacity-80">
                <Avatar size={AVATAR_SIZE} />
                {settingPhoto ? (
                  <View
                    style={{ borderRadius: AVATAR_SIZE / 2 }}
                    className="absolute inset-0 items-center justify-center bg-scrim/45">
                    <ActivityIndicator className="text-onPhoto" />
                  </View>
                ) : (
                  <View className="absolute -bottom-0.5 -right-0.5 h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-accent">
                    <Icon
                      name="camera"
                      size={11}
                      className="text-textPrimary dark:text-background"
                    />
                  </View>
                )}
              </Pressable>
            }
            leadingWidth={AVATAR_SIZE}
            accessibilityLabel={profile.data ? `Signed in as ${profile.data.fullName}` : undefined}
            trailing={profile.status === 'pending' ? <ActivityIndicator /> : undefined}>
            <Text className="font-h2 text-h2 text-textPrimary">
              {profile.data?.fullName ?? ' '}
            </Text>
            {email ? (
              <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                {email}
              </Text>
            ) : null}
          </Row>
        )}
      </Section>
      <SectionGap />
      <Section>
        <Row
          title={
            loggingOut ? byPlatform('Logging Out', 'Logging out') : byPlatform('Log Out', 'Log out')
          }
          destructive
          center
          disabled={loggingOut}
          onPress={confirmLogOut}
        />
      </Section>
    </LargeTitleScreen>
  );
}
