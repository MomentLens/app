import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

const subscribeToNothing = () => () => {};

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme() {
  // Static rendering and hydration read the server snapshot (false), then React re-renders
  // with the client snapshot (true). A client-only render reads true straight away, where
  // the setState-in-effect version this replaced always rendered twice.
  const hasHydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  const colorScheme = useRNColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
