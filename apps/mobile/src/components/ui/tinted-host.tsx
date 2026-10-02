import { Host } from '@expo/ui';
import { cssInterop } from 'nativewind';

// @expo/ui's Host takes its tint as a prop: SwiftUI's tint on iOS, and on Android the seed of the
// Material 3 color scheme its controls draw from. This moves a text-* token's color onto it, as
// icon.tsx does for an Svg, so switches, sliders and pickers are gold in both modes with no hex in
// a component. Pass className="text-accent".
export const TintedHost = cssInterop(Host, {
  className: { target: 'style', nativeStyleToProp: { color: 'seedColor' } },
});
