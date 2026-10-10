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

// The native tab bar's height above the bottom safe area, which a button floating over a tab's
// content clears on iOS, as My Media's camera button does (hb §16.5). Native tabs cannot measure
// their own bar, so it is iOS's 49pt bar, rounded up. Android lays a tab's content out above its
// navigation bar, so a FAB there sits 16dp above the content's bottom edge and clears nothing.
export const BottomTabInset = Platform.select({ ios: 50, android: 0 }) ?? 0;
