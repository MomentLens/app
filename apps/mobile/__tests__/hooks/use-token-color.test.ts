import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { tokenToRgba } from '@/hooks/use-token-color';

describe('tokenToRgba', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  afterEach(() => {
    consoleError.mockClear();
  });

  it('reads the RGB triple global.css stores', () => {
    expect(tokenToRgba('accent', '200 155 60', 1)).toBe('rgba(200, 155, 60, 1)');
  });

  it('reads the triple once NativeWind has parsed it into numbers', () => {
    expect(tokenToRgba('accent', [200, 155, 60], 0.12)).toBe('rgba(200, 155, 60, 0.12)');
  });

  it('gives undefined for a missing token and reports it, rather than throwing mid-render', () => {
    expect(tokenToRgba('nope', undefined, 1)).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('--color-nope'));
  });

  it('gives undefined for a value that is not three numbers', () => {
    expect(tokenToRgba('accent', '200 155', 1)).toBeUndefined();
    expect(tokenToRgba('accent', 'gold', 1)).toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});
