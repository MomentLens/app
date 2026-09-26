import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/ui/app-header';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { logout } from '@/features/auth/logout';
import { useMyProfile } from '@/hooks/use-my-profile';

// The Profile tab, as far as S-02 needs it: who is signed in, and Log out, which moves here from
// the old home screen until Account Settings has one (spec §4.19).
export default function ProfileTab() {
  const profile = useMyProfile();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logOut() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      // Normally this screen is gone by now, because logging out closes the signed-in group.
      setLoggingOut(false);
    }
  }

  return (
    <View className="flex-1 bg-background">
      {/* SafeAreaView is not a React Native core component, so its layout stays in style. */}
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'left', 'right']}>
        <View className="px-4">
          <AppHeader />
        </View>
        <View className="flex-1 items-center gap-6 px-6 pt-10">
          <Avatar size={88} />
          {profile.status === 'pending' ? (
            <ActivityIndicator className="text-accent" />
          ) : profile.status === 'error' ? (
            <View className="w-full items-center gap-3">
              <Text className="text-center font-h2 text-h2 text-danger">
                Your profile could not be loaded
              </Text>
              <Button
                label={profile.isFetching ? 'Trying again' : 'Try again'}
                variant="secondary"
                busy={profile.isFetching}
                onPress={() => void profile.refetch()}
              />
            </View>
          ) : (
            <View className="items-center gap-1">
              <Text className="font-caption text-caption text-textSecondary">Signed in as</Text>
              <Text className="text-center font-h1 text-h1 text-textPrimary">
                {profile.data.fullName}
              </Text>
            </View>
          )}
          <Button
            label={loggingOut ? 'Logging out' : 'Log out'}
            variant="secondary"
            icon="log-out"
            busy={loggingOut}
            onPress={() => void logOut()}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}
