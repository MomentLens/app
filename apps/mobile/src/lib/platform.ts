import { Platform } from 'react-native';

// Whether the tab bar sets a search-role item apart, as a round button at its trailing end. iOS 26
// does; iOS before it puts the item among the tabs, labelled "Search", and Android has no such
// item. Platform.Version is a string such as "26.1" on iOS and a number on Android.
export function tabBarHasActionSlot(os: string, version: string | number): boolean {
  return os === 'ios' && Number.parseInt(String(version), 10) >= 26;
}

// The Global shell puts Create Event in that slot, and falls back to a floating button everywhere
// else: Android, where Material 3 has the FAB, and older iOS (D-112).
export const CREATE_IN_TAB_BAR = tabBarHasActionSlot(Platform.OS, Platform.Version);
