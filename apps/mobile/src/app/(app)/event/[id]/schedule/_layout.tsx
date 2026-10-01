import { Stack } from 'expo-router';

import { useTokenColor } from '@/hooks/use-token-color';

// The Schedule tab's own stack, as Expo Router's native tabs expect for a tab that opens other
// screens. The Event shell draws the header above every tab, so the stack draws none. Sub-event
// Detail opens as a native sheet that fits its content, as the Figma Sub-Event Detail frame draws it.
export default function ScheduleLayout() {
  const background = useTokenColor('background');
  const surface = useTokenColor('surface');
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen
        name="[subEventId]"
        options={{
          presentation: 'formSheet',
          sheetAllowedDetents: 'fitToContents',
          sheetGrabberVisible: true,
          contentStyle: { backgroundColor: surface },
        }}
      />
    </Stack>
  );
}
