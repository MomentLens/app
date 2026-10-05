import '../../global.css';

import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import * as Sentry from '@sentry/react-native';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { startSessionSync } from '@/features/auth/session';
import { initializeQueue, startUploads } from '@/features/upload-queue/queue';
import { persistOptions, queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

// Uncaught errors and native crashes only: no tracing, no session replay. Screenshots, the view
// hierarchy and replay would all send what is on screen to Sentry, and on this app that is photos of
// faces, including people who turned on Do Not Publish. They stay off (apps/mobile/AGENTS.md).
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
// Sweep copies left by a kill before the queue INSERT, whichever tab opens first (D-145).
void initializeQueue().catch(() => {
  // My Media retries initialization and shows a local-storage error.
  console.warn('The upload queue could not be opened. My Media will retry.');
});
// Uploads the signed-in account's queued photos, and moves to the next account's on every switch
// (D-146).
startUploads();

// The keys are the family names tailwind.config.js uses, so `font-h1` resolves to Fraunces_600SemiBold.
// Each weight is imported from its own path, which keeps the package's other font files out of the
// bundle. Everything else uses the system font (D-124), which needs no loading.
const FONTS = {
  Fraunces_600SemiBold,
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

  // The native splash, the aperture on cream (D-124), stays up until the fonts settle, so the first
  // frame already has its titles in Fraunces. A failed load still hides it and renders the app with
  // system fonts, rather than holding the splash forever.
  const fontsSettled = fontsLoaded || fontError !== null;
  useEffect(() => {
    if (fontsSettled) {
      void SplashScreen.hideAsync();
    }
  }, [fontsSettled]);

  if (!fontsSettled) {
    return null;
  }

  // Exactly one of the first three is open at a time, and a guard that closes on the screen in
  // view sends the user to the first one open (Expo Router's protected routes). The rest are always
  // open: the recovery link and an invite link have to work in every state, and Manual Join Entry,
  // Join Error and Join Blocked are reached signed in and signed out alike (spec §2.4).
  //
  // The provider restores the queries saved for an offline start before any query fetches (D-118).
  return (
    // Gesture Handler's root, which the Schedule's swipe action needs (D-127).
    <GestureHandlerRootView style={{ flex: 1 }}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          {/* Dark icons on the light palette and light on the dark one. Without it Android kept the
            template theme's white icons, which vanished on the cream background. */}
          <StatusBar style="auto" />
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
            <Stack.Screen name="invite/[token]" />
            <Stack.Screen name="join-code" />
            <Stack.Screen name="join-error" />
            <Stack.Screen name="join-blocked" />
          </Stack>
        </ThemeProvider>
      </PersistQueryClientProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap adds a breadcrumb for each touch, recorded by component name, not on-screen text.
export default Sentry.wrap(RootLayout);
