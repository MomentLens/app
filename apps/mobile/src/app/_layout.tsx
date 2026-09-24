import '../../global.css';

import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { startSessionSync } from '@/features/auth/session';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

// Uncaught errors and native crashes only: no tracing, no session replay. Screenshots, the view
// hierarchy and replay would all send what is on screen to Sentry, and on this app that is photos of
// faces, including people who turned on Do Not Publish. They stay off (apps/mobile/CLAUDE.md).
// With EXPO_PUBLIC_SENTRY_DSN unset the SDK reports nothing. Both variables are read with dot
// notation, the only form Expo inlines at build time.
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
  sendDefaultPii: false,
  attachScreenshot: false,
  attachViewHierarchy: false,
});

SplashScreen.preventAutoHideAsync();

// Here rather than in an effect, so the store already knows who is signed in when the first frame
// renders, and so the Auth subscription exists before anything auth-js does at startup is announced.
startSessionSync();

// The keys are the family names tailwind.config.js uses, so `font-h1` resolves to Fraunces_600SemiBold.
// Each weight is imported from its own path, which keeps the package's other font files out of the
// bundle. A weight added to the type scale has to be added here too.
const FONTS = {
  Fraunces_600SemiBold,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
};

function RootLayout() {
  const colorScheme = useColorScheme();
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const status = useAuthStore((state) => state.status);

  useEffect(() => {
    if (fontError) {
      console.warn('Fonts failed to load, so text falls back to the system font.', fontError);
    }
  }, [fontError]);

  // AnimatedSplashOverlay hides the native splash as soon as it lays out, so rendering nothing keeps
  // the splash up until the fonts settle. A failed load still renders the app, with system fonts,
  // rather than holding the splash forever.
  if (!fontsLoaded && !fontError) {
    return null;
  }

  // Exactly one of the first three is open at a time, and a guard that closes on the screen in
  // view sends the user to the first one open (Expo Router's protected routes). reset-password is
  // always open, because the recovery link has to work in every state.
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={status === 'signedIn'}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'sessionEnded'}>
            <Stack.Screen name="session-ended" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'signedOut'}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Screen name="reset-password" />
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

// Sentry.wrap adds a breadcrumb for each touch, recorded by component name, not on-screen text.
export default Sentry.wrap(RootLayout);
