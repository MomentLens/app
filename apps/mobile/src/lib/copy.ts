import { Platform } from 'react-native';

// A label in each platform's capitalization: title case on iOS, where buttons, titles and menu
// items take it, and sentence case on Android, as Material 3 writes them (D-124).
export function byPlatform(ios: string, android: string): string {
  return Platform.OS === 'ios' ? ios : android;
}
