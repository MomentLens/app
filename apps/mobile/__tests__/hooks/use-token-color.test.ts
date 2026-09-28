import { describe, expect, it } from '@jest/globals';

import { tokenToRgba } from '@/hooks/use-token-color';

describe('tokenToRgba', () => {
  it('reads the RGB triple global.css stores', () => {
    expect(tokenToRgba('accent', '200 155 60', 1)).toBe('rgba(200, 155, 60, 1)');
  });

  it('reads the triple once NativeWind has parsed it into numbers', () => {
    expect(tokenToRgba('accent', [200, 155, 60], 0.12)).toBe('rgba(200, 155, 60, 0.12)');
  });

  it('refuses a token that is missing, rather than painting a default color', () => {
    expect(() => tokenToRgba('nope', undefined, 1)).toThrow('--color-nope');
  });

  it('refuses a value that is not three numbers', () => {
    expect(() => tokenToRgba('accent', '200 155', 1)).toThrow();
    expect(() => tokenToRgba('accent', 'gold', 1)).toThrow();
  });
});
