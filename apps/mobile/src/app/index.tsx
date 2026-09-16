import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useHealth } from '@/hooks/use-health';
import { API_URL } from '@/lib/api';

// P0-4's proof that a phone reaches the deployed API and the API reaches Supabase. S-08 replaces
// this screen with the real home screen, and P0-6's tokens replace the template's theme.
export default function HomeScreen() {
  const health = useHealth();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle">MomentLens</ThemedText>
        <ThemedText type="code" themeColor="textSecondary">
          {API_URL ?? 'EXPO_PUBLIC_API_URL is not set'}
        </ThemedText>

        <ThemedView type="backgroundElement" style={styles.card}>
          <HealthResult health={health} />
        </ThemedView>

        <Pressable
          accessibilityRole="button"
          disabled={health.isFetching}
          onPress={() => void health.refetch()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <ThemedText type="link">{health.isFetching ? 'Checking' : 'Check again'}</ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

function HealthResult({ health }: { health: ReturnType<typeof useHealth> }) {
  if (health.status === 'pending') {
    return (
      <>
        <ActivityIndicator />
        <ThemedText type="small">Checking the API</ThemedText>
      </>
    );
  }
  if (health.status === 'error') {
    return (
      <>
        <ThemedText type="smallBold">The API could not be checked</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {health.error.message}
        </ThemedText>
      </>
    );
  }
  const { status, database, checkedAt } = health.data;
  return (
    <>
      <ThemedText type="smallBold">
        {status === 'ok'
          ? 'The API and the database both answer'
          : 'The API answers, but the database does not'}
      </ThemedText>
      <Row label="API" value={status} />
      <Row label="Database" value={database} />
      <Row label="Checked at" value={new Date(checkedAt).toLocaleTimeString()} />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <ThemedView type="backgroundElement" style={styles.row}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="code">{value}</ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row',
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.three,
    maxWidth: MaxContentWidth,
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  button: {
    alignSelf: 'center',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  pressed: {
    opacity: 0.6,
  },
});
