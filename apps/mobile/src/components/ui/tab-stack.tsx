import { Stack } from 'expo-router';

import { useTokenColor } from '@/hooks/use-token-color';

// The Stack inside a tab, which Expo Router's native tabs need for a tab that opens other screens
// or, on iOS, shows a native bar (D-125). The bar is off until a screen turns it on, as
// LargeTitleScreen does on iOS; Android draws its own top app bar inside the screen.
export function TabStack() {
  const background = useTokenColor('background');
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }} />
  );
}
