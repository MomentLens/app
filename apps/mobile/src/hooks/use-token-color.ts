import { useUnstableNativeVariable } from 'nativewind';

// A color token's value as rgba(). global.css stores each token as an RGB triple, "200 155 60", so
// tailwind.config.js can add an alpha, and NativeWind hands it back as that string or, once parsed,
// as an array of numbers. Anything else means the token is missing or malformed, which is a bug.
export function tokenToRgba(token: string, value: unknown, alpha: number): string {
  const channels = Array.isArray(value)
    ? value.map(Number)
    : String(value ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`No color token --color-${token} in global.css`);
  }
  const [red, green, blue] = channels;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

// A color token from global.css as a value a native prop takes, for the few props that want a color
// rather than a class: the native tab bar's colors, and Android's ripple. It follows dark mode,
// because NativeWind re-renders the caller when the variable changes.
export function useTokenColor(token: string, alpha = 1): string {
  return tokenToRgba(token, useUnstableNativeVariable(`--color-${token}`), alpha);
}
