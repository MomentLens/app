import { describe, expect, it } from '@jest/globals';

import {
  APO,
  aperture,
  BAR,
  CLOSE,
  cubicBezier,
  END,
  endScaleFor,
  interiorOpacity,
  lensRotation,
  lensScale,
  MARK_DIAMETER,
  OPEN,
  R_IN,
  SHUT,
  SQRT3,
  UNIT,
} from '@/features/launch/iris-timeline';

describe('the launch animation', () => {
  it('starts on the native splash exactly: the mark at rest, 128 points across', () => {
    // splash-icon.png's ring spans 446 of its 512 pixels, drawn 147 points wide (app.json).
    expect(MARK_DIAMETER).toBeCloseTo(128.05, 2);
    expect(aperture(0)).toBe(APO);
    expect(lensRotation(0)).toBe(0);
    expect(lensScale(0, 12)).toBe(1);
    expect(interiorOpacity(0)).toBe(1);
    // and holds there until the shutter moves
    expect(aperture(CLOSE)).toBe(APO);
  });

  it('shuts the shutter, holds it, then opens it fully into the ring', () => {
    expect(aperture(SHUT)).toBe(0);
    expect(aperture(OPEN)).toBe(0);
    expect(aperture(END)).toBe(R_IN);
  });

  it("ends with the ring's opening past every corner of the screen", () => {
    for (const [width, height] of [
      [390, 844],
      [412, 892],
      [360, 800],
      [440, 956],
    ]) {
      const end = endScaleFor(width, height);
      expect(lensScale(END, end)).toBeCloseTo(end, 6);
      expect(R_IN * UNIT * end).toBeGreaterThan(Math.hypot(width, height) / 2);
    }
  });

  it('plays the same curve as CSS cubic-bezier', () => {
    // CSS's `ease` at half time
    expect(cubicBezier([0.25, 0.1, 0.25, 1], 0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier([0.4, 0, 0.2, 1], 0)).toBe(0);
    expect(cubicBezier([0.4, 0, 0.2, 1], 1)).toBe(1);
  });

  // Each bar is drawn as a rectangle cut square at the corner of the opening, where the icon cuts
  // it on a slant. The extra corner must always land inside the bar before it, which is the same
  // gold, or the drawing would differ from the icon.
  it("hides each bar's square corner inside the previous bar at every opening", () => {
    for (let a = 0; a <= R_IN; a += 1) {
      // the corner the square cut adds, in this bar's frame
      const x = -a / SQRT3;
      const y = -(a + BAR);
      // the same point in the previous bar's frame, turned back by -60 degrees
      const turn = Math.PI / 3;
      const px = x * Math.cos(turn) - y * Math.sin(turn);
      const py = x * Math.sin(turn) + y * Math.cos(turn);
      // inside that bar's band, past where it starts
      expect(py).toBeLessThanOrEqual(-a + 1e-9);
      expect(py).toBeGreaterThanOrEqual(-(a + BAR) - 1e-9);
      expect(px).toBeGreaterThanOrEqual(-a / SQRT3 - 1e-9);
    }
  });
});
