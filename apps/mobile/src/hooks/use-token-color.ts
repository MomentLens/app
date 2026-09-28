import { useUnstableNativeVariable } from 'nativewind';

// A color token's value as rgba(), or undefined when it cannot be read. global.css stores each
// token as an RGB triple, "200 155 60", so tailwind.config.js can add an alpha, and NativeWind hands
// it back as that string or, once parsed, as an array of numbers.
//
// Anything else is a bug, a misspelt token or NativeWind changing what it returns. It is reported
// loudly in development, and the caller gets undefined, which a native color prop reads as the
// platform's default. A wrong tab bar color is not worth taking the app down for.
export function tokenToRgba(token: string, value: unknown, alpha: number): string | undefined {
  const channels = Array.isArray(value)
    ? value.map(Number)
    : String(value ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    if (__DEV__) {
      console.error(`No color token --color-${token} in global.css, got ${JSON.stringify(value)}`);
    }
    return undefined;
  }
  const [red, green, blue] = channels;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

// A color token from global.css as a value a native prop takes, for the few props that want a color
// rather than a class, such as the native tab bar's colors and Android's ripple. It follows dark mode,
// because NativeWind re-renders the caller when the variable changes.
export function useTokenColor(token: string, alpha = 1): string | undefined {
  return tokenToRgba(token, useUnstableNativeVariable(`--color-${token}`), alpha);
}
