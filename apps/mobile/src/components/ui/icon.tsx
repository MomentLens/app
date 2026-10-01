import { cssInterop } from 'nativewind';
import type { ReactElement } from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

// The icons the Figma frames use, drawn with react-native-svg, which the build already has. The
// paths are Lucide's (lucide.dev, ISC licence), the set the frames were drawn with.
//
// Every stroke is currentColor and the color comes from a token class, e.g. className="text-accent".
// NativeWind maps a class to a style, and this moves the style's color onto the Svg's color prop,
// the same mapping NativeWind ships for ActivityIndicator. No hex, so dark mode follows the tokens.
const StyledSvg = cssInterop(Svg, {
  className: { target: 'style', nativeStyleToProp: { color: true } },
});

const PATHS = {
  aperture: (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Path d="m14.31 8 5.74 9.94" />
      <Path d="M9.69 8h11.48" />
      <Path d="m7.38 12 5.74-9.94" />
      <Path d="M9.69 16 3.95 6.06" />
      <Path d="M14.31 16H2.83" />
      <Path d="m16.62 12-5.74 9.94" />
    </>
  ),
  ban: (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Path d="M4.929 4.929 19.07 19.071" />
    </>
  ),
  bell: (
    <>
      <Path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <Path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </>
  ),
  calendar: (
    <>
      <Path d="M8 2v4" />
      <Path d="M16 2v4" />
      <Rect width="18" height="18" x="3" y="4" rx="2" />
      <Path d="M3 10h18" />
    </>
  ),
  camera: (
    <>
      <Path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <Circle cx="12" cy="13" r="3" />
    </>
  ),
  check: <Path d="M20 6 9 17l-5-5" />,
  'chevron-down': <Path d="m6 9 6 6 6-6" />,
  'chevron-left': <Path d="m15 18-6-6 6-6" />,
  'chevron-right': <Path d="m9 18 6-6-6-6" />,
  'clipboard-paste': (
    <>
      <Path d="M11 14h10" />
      <Path d="M16 4h2a2 2 0 0 1 2 2v1.344" />
      <Path d="m17 18 4-4-4-4" />
      <Path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113" />
      <Rect x="8" y="2" width="8" height="4" rx="1" />
    </>
  ),
  'circle-dot': (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Circle cx="12" cy="12" r="1" />
    </>
  ),
  'circle-alert': (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Line x1="12" x2="12" y1="8" y2="12" />
      <Line x1="12" x2="12.01" y1="16" y2="16" />
    </>
  ),
  clock: (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Path d="M12 6v6l4 2" />
    </>
  ),
  eye: (
    <>
      <Path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <Path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <Path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <Path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <Path d="m2 2 20 20" />
    </>
  ),
  images: (
    <>
      <Path d="M18 22H4a2 2 0 0 1-2-2V6" />
      <Path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18" />
      <Circle cx="12" cy="8" r="2" />
      <Rect width="16" height="16" x="6" y="2" rx="2" />
    </>
  ),
  'locate-fixed': (
    <>
      <Line x1="2" x2="5" y1="12" y2="12" />
      <Line x1="19" x2="22" y1="12" y2="12" />
      <Line x1="12" x2="12" y1="2" y2="5" />
      <Line x1="12" x2="12" y1="19" y2="22" />
      <Circle cx="12" cy="12" r="7" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  link: (
    <>
      <Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <Path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  'link-2-off': (
    <>
      <Path d="M9 17H7A5 5 0 0 1 7 7" />
      <Path d="M15 7h2a5 5 0 0 1 4 8" />
      <Line x1="8" x2="12" y1="12" y2="12" />
      <Line x1="2" x2="22" y1="2" y2="22" />
    </>
  ),
  lock: (
    <>
      <Rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  'log-out': (
    <>
      <Path d="m16 17 5-5-5-5" />
      <Path d="M21 12H9" />
      <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </>
  ),
  'map-pin': (
    <>
      <Path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <Circle cx="12" cy="10" r="3" />
    </>
  ),
  mail: (
    <>
      <Path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <Rect x="2" y="4" width="20" height="16" rx="2" />
    </>
  ),
  navigation: <Path d="M3 11 22 2 13 21 11 13Z" />,
  pencil: (
    <>
      <Path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <Path d="m15 5 4 4" />
    </>
  ),
  plus: (
    <>
      <Path d="M5 12h14" />
      <Path d="M12 5v14" />
    </>
  ),
  'qr-code': (
    <>
      <Rect width="5" height="5" x="3" y="3" rx="1" />
      <Rect width="5" height="5" x="16" y="3" rx="1" />
      <Rect width="5" height="5" x="3" y="16" rx="1" />
      <Path d="M21 16h-3a2 2 0 0 0-2 2v3" />
      <Path d="M21 21v.01" />
      <Path d="M12 7v3a2 2 0 0 1-2 2H7" />
      <Path d="M3 12h.01" />
      <Path d="M12 3h.01" />
      <Path d="M12 16v.01" />
      <Path d="M16 12h1" />
      <Path d="M21 12v.01" />
      <Path d="M12 21v-1" />
    </>
  ),
  search: (
    <>
      <Circle cx="11" cy="11" r="8" />
      <Path d="m21 21-4.3-4.3" />
    </>
  ),
  send: (
    <>
      <Path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <Path d="m21.854 2.147-10.94 10.939" />
    </>
  ),
  ticket: (
    <>
      <Path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <Path d="M13 5v2" />
      <Path d="M13 17v2" />
      <Path d="M13 11v2" />
    </>
  ),
  'trash-2': (
    <>
      <Path d="M10 11v6" />
      <Path d="M14 11v6" />
      <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <Path d="M3 6h18" />
      <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  x: (
    <>
      <Path d="M18 6 6 18" />
      <Path d="m6 6 12 12" />
    </>
  ),
  user: (
    <>
      <Path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <Circle cx="12" cy="7" r="4" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  // A text-* token class, which sets the stroke color.
  className?: string;
  size?: number;
}

// Decorative: a screen reader skips it, and whatever holds it carries the label.
export function Icon({ name, className, size = 20 }: IconProps) {
  return (
    <StyledSvg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {PATHS[name]}
    </StyledSvg>
  );
}
