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
  'chevron-left': <Path d="m15 18-6-6 6-6" />,
  'circle-alert': (
    <>
      <Circle cx="12" cy="12" r="10" />
      <Line x1="12" x2="12" y1="8" y2="12" />
      <Line x1="12" x2="12.01" y1="16" y2="16" />
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
  link: (
    <>
      <Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <Path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
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
  mail: (
    <>
      <Path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <Rect x="2" y="4" width="20" height="16" rx="2" />
    </>
  ),
  send: (
    <>
      <Path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <Path d="m21.854 2.147-10.94 10.939" />
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
