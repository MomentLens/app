import { useState } from 'react';
import { ActivityIndicator, Alert, Text } from 'react-native';

import { Avatar } from '@/components/ui/avatar';
import { Row, Section, SectionGap } from '@/components/ui/grouped';
import { LargeTitleScreen } from '@/components/ui/large-title-screen';
import { logout } from '@/features/auth/logout';
import { useAccountEmail } from '@/features/auth/use-account-email';
import { useMyProfile } from '@/hooks/use-my-profile';
import { byPlatform } from '@/lib/copy';

// The Profile tab (spec §4.19): who is signed in, and Log Out. Account Settings' grouped rows,
// Do Not Publish among them, arrive with S-29 in spec §4.19's order (spec §2.5.9).
export default function ProfileTab() {
  const profile = useMyProfile();
  const email = useAccountEmail();
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
            leading={<Avatar size={52} />}
            leadingWidth={52}
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
