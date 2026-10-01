import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Space under the content of a native sheet that fits its content. iOS already adds the home
// indicator's inset to such a sheet; Android does not (react-native-screens, sheetAllowedDetents).
export function useSheetBottomPadding(): number {
  const insets = useSafeAreaInsets();
  return (Platform.OS === 'ios' ? 0 : insets.bottom) + 24;
}
