import { Stack } from 'expo-router';

import { useTokenColor } from '@/hooks/use-token-color';

// The Schedule tab's own stack, as Expo Router's native tabs expect for a tab that opens other
// screens. The Event shell draws the header above every tab, so the stack draws none. Sub-event
// Detail and Delay open as native sheets that fit their content, as the Figma Sub-Event Detail frame
// draws one. @expo/ui's sheet, which the full-height forms use, sizes a sheet that fits its content
// from the content's own width, so on iOS the content never filled the sheet (build mobile).
export default function ScheduleLayout() {
  const background = useTokenColor('background');
  const surface = useTokenColor('surface');
  const sheet = {
    presentation: 'formSheet',
    sheetAllowedDetents: 'fitToContents',
    sheetGrabberVisible: true,
    contentStyle: { backgroundColor: surface },
  } as const;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[subEventId]" options={sheet} />
      <Stack.Screen name="delay/[subEventId]" options={sheet} />
    </Stack>
  );
}
