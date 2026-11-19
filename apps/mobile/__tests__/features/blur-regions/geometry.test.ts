import { describe, expect, it } from '@jest/globals';
import { BlurRect } from '@momentlens/shared-types';

import {
  cornerAt,
  fitContain,
  fromFractions,
  isTooSmall,
  moveWithin,
  rectBetween,
  toFractions,
} from '@/features/blur-regions/geometry';

const frame = { width: 300, height: 400 };

describe('fitContain', () => {
  it('fits a landscape photo to the box width, centred', () => {
    expect(fitContain({ width: 4000, height: 3000 }, { width: 400, height: 700 })).toEqual({
      x: 0,
      y: 200,
      width: 400,
      height: 300,
    });
  });
  it('gives an empty frame before either size is known', () => {
    expect(fitContain({ width: 0, height: 0 }, { width: 400, height: 700 }).width).toBe(0);
  });
});

describe('rectBetween', () => {
  it('orders the corners whichever way the drag ran', () => {
    expect(rectBetween(200, 300, 100, 100, frame)).toEqual({
      x: 100,
      y: 100,
      width: 100,
      height: 200,
    });
  });
  it('stops a drag that runs off the photo at its edge', () => {
    expect(rectBetween(250, 350, 900, -50, frame)).toEqual({
      x: 250,
      y: 0,
      width: 50,
      height: 350,
    });
  });
});

describe('isTooSmall (D-170)', () => {
  it('ignores a tap-sized drag', () => {
    expect(isTooSmall({ x: 0, y: 0, width: 10, height: 15 })).toBe(true);
  });
  it('keeps a drag of 24 points or more', () => {
    expect(isTooSmall({ x: 0, y: 0, width: 24, height: 0 })).toBe(false);
  });
});

describe('moveWithin', () => {
  it('keeps the whole rectangle on the photo', () => {
    expect(moveWithin({ x: 200, y: 10, width: 80, height: 50 }, 100, -100, frame)).toEqual({
      x: 220,
      y: 0,
      width: 80,
      height: 50,
    });
  });
});

describe('cornerAt', () => {
  const rect = { x: 100, y: 100, width: 100, height: 100 };
  it('finds the bottom-right handle within reach', () => {
    expect(cornerAt(rect, 215, 190)).toBe(2);
  });
  it('finds nothing in the middle', () => {
    expect(cornerAt(rect, 150, 150)).toBe(-1);
  });
});

describe('toFractions', () => {
  it('turns points into fractions of the photo', () => {
    expect(toFractions({ x: 75, y: 100, width: 150, height: 200 }, frame)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });
  });
  it('never lets x + width pass 1 at the right edge, so the schema accepts it', () => {
    const third = 300 / 3;
    for (const x of [third, 2 * third, 299.99999]) {
      const rect = toFractions({ x, y: 0, width: 300 - x, height: 400 }, frame);
      if (rect === null) continue;
      expect(BlurRect.safeParse(rect).success).toBe(true);
    }
  });
  it('gives null for a rectangle with no area', () => {
    expect(toFractions({ x: 300, y: 0, width: 0, height: 10 }, frame)).toBeNull();
  });
  it('round-trips through fromFractions', () => {
    const rect = { x: 30, y: 40, width: 90, height: 120 };
    const back = fromFractions(toFractions(rect, frame)!, frame);
    expect(back.x).toBeCloseTo(30);
    expect(back.height).toBeCloseTo(120);
  });
});
