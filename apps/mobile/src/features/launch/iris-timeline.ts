// The launch animation's timeline, ported from designs/splash/src/s21_iris.py. Each track is a
// list of keys [ms, value, ease]. The ease on a key shapes the move to the next key, and a key
// without one holds its value until the next key, as in the Rive scene the design was built in.
//
// Pure functions with no imports, so they run as worklets on the UI thread and in Jest alike.

// The mark, in the units of the 1024 px app icon: a ring from radius 243 to 290 and six bars 47
// wide whose inner edges sit 83 from the centre. The bars are the shutter: move that 83 and they
// slide together, with the opening a hexagon throughout. 0 shuts it, 243 hides every bar inside
// the ring.
export const R_OUT = 290;
export const R_IN = 243;
export const BAR = 47;
export const APO = 83;
export const SQRT3 = Math.sqrt(3);

// The native splash draws splash-icon.png at this width (app.json, expo-splash-screen's
// imageWidth), and the ring spans 446 of that image's 512 pixels. The overlay's first frame has to
// match it to the point, so a change to either one changes this too.
export const SPLASH_IMAGE_WIDTH = 147;
export const MARK_DIAMETER = (SPLASH_IMAGE_WIDTH * 446) / 512;
// Points per icon unit.
export const UNIT = MARK_DIAMETER / 2 / R_OUT;

type Ease = readonly [number, number, number, number];
type Key = readonly [number, number, Ease?];

const SHUTTER_IN: Ease = [0.55, 0, 0.9, 0.45];
const SHUTTER_OUT: Ease = [0.25, 0, 0, 1];
const SOFT: Ease = [0.4, 0, 0.2, 1];
const ZOOM_IN: Ease = [0.55, 0, 0.85, 0.2];
const EXPO_OUT: Ease = [0.16, 1, 0.3, 1];

// The design held the still mark for 360 ms. Here the native splash has already shown it while
// JavaScript started, so the shutter moves after 120 ms; every key is the design's minus 240.
export const CLOSE = 120; // the shutter starts to close
export const SHUT = 215; // fully shut
export const OPEN = 285; // starts to open; the animation waits here until the app has rendered
const WIDE = 820; // every bar is inside the ring
const ZOOM0 = 460;
export const END = 1040; // the opening covers the screen
export const CLICK_END = 520; // the click ring's own clock, started at SHUT

// CSS's cubic-bezier: solve x(s) = x for s by Newton's method, falling back to bisection.
export function cubicBezier(ease: Ease, x: number): number {
  'worklet';
  const [x1, y1, x2, y2] = ease;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = ((ax * s + bx) * s + cx) * s - x;
    if (Math.abs(err) < 1e-6) return ((ay * s + by) * s + cy) * s;
    const slope = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(slope) < 1e-6) break;
    s -= err / slope;
  }
  let lo = 0;
  let hi = 1;
  s = x;
  for (let i = 0; i < 30; i++) {
    const value = ((ax * s + bx) * s + cx) * s;
    if (Math.abs(value - x) < 1e-6) break;
    if (value < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return ((ay * s + by) * s + cy) * s;
}

export function track(keys: readonly Key[], t: number): number {
  'worklet';
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0, ease] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (t <= t1) {
      if (!ease) return v0;
      return v0 + (v1 - v0) * cubicBezier(ease, (t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

const APERTURE: readonly Key[] = [
  [0, APO],
  [CLOSE, APO, SHUTTER_IN],
  [SHUT, 0],
  [OPEN, 0, SHUTTER_OUT],
  [WIDE, R_IN],
];

// The lens turns a little as it shuts, then the other way as it opens, the way a lens ring does.
const ROTATION: readonly Key[] = [
  [0, 0],
  [CLOSE, 0, SHUTTER_IN],
  [SHUT, -0.09],
  [OPEN, -0.09, SHUTTER_OUT],
  [END, 0.62],
];

const INTERIOR: readonly Key[] = [
  [0, 1],
  [OPEN, 1, SOFT],
  [OPEN + 420, 0],
];

const CLICK_SCALE: readonly Key[] = [
  [0, 1, EXPO_OUT],
  [CLICK_END, 1.42],
];

const CLICK_OPACITY: readonly Key[] = [
  [0, 0.55, EXPO_OUT],
  [CLICK_END, 0],
];

// Distance from the centre to the inner edge of each bar, in icon units.
export function aperture(t: number): number {
  'worklet';
  return track(APERTURE, t);
}

// Radians.
export function lensRotation(t: number): number {
  'worklet';
  return track(ROTATION, t);
}

export function lensScale(t: number, endScale: number): number {
  'worklet';
  return track(
    [
      [0, 1],
      [CLOSE, 1, SOFT],
      [SHUT, 0.975, SOFT],
      [OPEN, 0.985, SOFT],
      [ZOOM0, 1, ZOOM_IN],
      [END, endScale],
    ],
    t,
  );
}

// The cream inside the lens, which clears once the shutter opens so the app shows through.
export function interiorOpacity(t: number): number {
  'worklet';
  return track(INTERIOR, t);
}

// Whether the bars can be drawn at all; once the shutter is wide open they sit under the ring.
export function barsVisible(t: number): boolean {
  'worklet';
  return t < WIDE;
}

// The faint ring that leaves the mark the moment the shutter shuts. t is ms since SHUT.
export function clickScale(t: number): number {
  'worklet';
  return track(CLICK_SCALE, t);
}

export function clickOpacity(t: number): number {
  'worklet';
  return track(CLICK_OPACITY, t);
}

// How far the lens has to grow for the ring's opening to clear the corners of the screen, with a
// tenth to spare, and never less than the design's 10.5.
export function endScaleFor(width: number, height: number): number {
  return Math.max(10.5, (1.1 * Math.hypot(width, height)) / 2 / (R_IN * UNIT));
}
