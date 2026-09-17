import '../../global.css';

import { Fraunces_500Medium } from '@expo-google-fonts/fraunces/500Medium';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

SplashScreen.preventAutoHideAsync();

// The keys are the family names tailwind.config.js uses, so `font-h1` resolves to Fraunces_500Medium.
// Each weight is imported from its own path, which keeps the package's other font files out of the
// bundle. A weight added to the type scale has to be added here too.
const FONTS = { Fraunces_500Medium, Inter_400Regular, Inter_500Medium, Inter_600SemiBold };

export default function TabLayout() {
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
