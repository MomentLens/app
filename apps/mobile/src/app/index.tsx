import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { useHealth } from '@/hooks/use-health';
import { API_URL } from '@/lib/api';

// P0-4's proof that a phone reaches the deployed API and the API reaches Supabase, and the first
// screen on P0-6's tokens. S-08 replaces it with the real home screen.
export default function HomeScreen() {
  const health = useHealth();

  return (
    <View className="flex-1 flex-row justify-center bg-background">
      {/* SafeAreaView is not a React Native core component, so NativeWind does not map className on
          it. Its layout stays in style, and the tokens go on the View inside. */}
      <SafeAreaView style={{ flex: 1, maxWidth: MaxContentWidth, paddingBottom: BottomTabInset }}>
        <View className="flex-1 justify-center gap-4 px-6">
          <Text className="font-h1 text-h1 text-textPrimary">MomentLens</Text>
          <Text className="font-caption text-caption text-textSecondary">
            {API_URL ?? 'EXPO_PUBLIC_API_URL is not set'}
          </Text>

          <View className="gap-3 rounded-2xl border border-border bg-surface p-6">
            <HealthResult health={health} />
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={health.isFetching}
            onPress={() => void health.refetch()}
            className={`self-center rounded-full border border-borderStrong bg-surface px-6 py-3 active:bg-surfaceMuted ${health.isFetching ? 'opacity-60' : ''}`}>
            <Text className="font-buttonLabel text-buttonLabel text-textPrimary">
              {health.isFetching ? 'Checking' : 'Check again'}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

function HealthResult({ health }: { health: ReturnType<typeof useHealth> }) {
  if (health.status === 'pending') {
    return (
      <>
        <ActivityIndicator className="text-accent" />
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          Checking the API
        </Text>
      </>
    );
  }
  if (health.status === 'error') {
    return (
      <>
        <Text className="font-h2 text-h2 text-danger">The API could not be checked</Text>
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
          {health.error.message}
        </Text>
      </>
    );
  }
  const { status, database, checkedAt } = health.data;
  // The status reads as words, the way a printed report would give it. Color appears only on a value
  // that failed, so a healthy check has none and a failure stands out without a badge. The words
  // differ too, so the state never depends on color alone.
  return (
    <>
      <View className="gap-1">
        <Text className="font-h2 text-h2 text-textPrimary">
          {status === 'ok'
            ? 'The API and the database both answer'
            : 'The API answers, but the database does not'}
        </Text>
        <Text className="font-caption text-caption text-textSecondary">
          Checked at {new Date(checkedAt).toLocaleTimeString()}
        </Text>
      </View>
      {/* Any response parsed into health.data means the API answered, whatever its status says. */}
      <Row label="API" value="Answering" />
      <Row
        label="Database"
        value={database === 'ok' ? 'Answering' : 'Not answering'}
        failed={database !== 'ok'}
      />
    </>
  );
}

function Row({ label, value, failed = false }: { label: string; value: string; failed?: boolean }) {
  return (
    <View className="flex-row items-center justify-between border-t border-border pt-3">
      <Text className="font-fieldLabel text-fieldLabel text-textSecondary">{label}</Text>
      <Text className={`font-body text-body ${failed ? 'text-danger' : 'text-textPrimary'}`}>
        {value}
      </Text>
    </View>
  );
}
