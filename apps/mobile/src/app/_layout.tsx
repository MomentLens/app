import '../../global.css';

import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_500Medium } from '@expo-google-fonts/manrope/500Medium';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_700Bold } from '@expo-google-fonts/manrope/700Bold';
import * as Sentry from '@sentry/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

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

function TabLayout() {
  const colorScheme = useColorScheme();
  // One client for the app's lifetime. Holding it in state rather than at module scope keeps the
  // cache across Fast Refresh, which re-runs an edited module.
  const [queryClient] = useState(() => new QueryClient());
  const [fontsLoaded, fontError] = useFonts(FONTS);

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

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <AppTabs />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

// Sentry.wrap adds a breadcrumb for each touch, recorded by component name, not on-screen text.
export default Sentry.wrap(TabLayout);
