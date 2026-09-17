import type { ReactNode } from 'react';
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
  return (
    <>
      <Text className="font-h2 text-h2 text-textPrimary">
        {status === 'ok'
          ? 'The API and the database both answer'
          : 'The API answers, but the database does not'}
      </Text>
      <Row label="API">
        <StatusPill ok={status === 'ok'} label={status} />
      </Row>
      <Row label="Database">
        <StatusPill ok={database === 'ok'} label={database} />
      </Row>
      <Row label="Checked at">
        <Text className="font-body text-body text-textPrimary">
          {new Date(checkedAt).toLocaleTimeString()}
        </Text>
      </Row>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="flex-row items-center justify-between border-t border-border pt-3">
      <Text className="font-fieldLabel text-fieldLabel text-textSecondary">{label}</Text>
      {children}
    </View>
  );
}

// The tint uses an opacity modifier on the token, which only works because global.css stores each
// color as an RGB triple.
function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <View className={`rounded-full px-2.5 py-1 ${ok ? 'bg-success/20' : 'bg-danger/20'}`}>
      <Text className={`font-micro text-micro ${ok ? 'text-success' : 'text-danger'}`}>
        {label}
      </Text>
    </View>
  );
}
