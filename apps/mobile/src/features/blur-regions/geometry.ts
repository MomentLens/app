import type { BlurRect } from '@momentlens/shared-types';

// A rectangle in points, relative to the photo's top-left corner on screen.
export interface PointRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

// D-170: a drag shorter than this, measured corner to corner, is a tap and makes no region.
export const MIN_DRAG = 24;

// How close to a corner handle a drag must start to resize from it. Apple and Material both ask
// for a 44pt touch target, so 22pt either side of the handle's centre.
export const HANDLE_REACH = 22;

function clamp(value: number, low: number, high: number): number {
  'worklet';
  return Math.min(Math.max(value, low), high);
}

// Where a photo of `image` size sits when fitted whole inside `box`, centred, as expo-image's
// contentFit="contain" draws it. The frame is relative to the box's top-left corner.
export function fitContain(image: Size, box: Size): PointRect {
  'worklet';
  if (image.width <= 0 || image.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

// The rectangle between two points, each first pulled onto the photo, so a drag that runs off an
// edge stops at that edge.
export function rectBetween(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  frame: Size,
): PointRect {
  'worklet';
  const x1 = clamp(ax, 0, frame.width);
  const y1 = clamp(ay, 0, frame.height);
  const x2 = clamp(bx, 0, frame.width);
  const y2 = clamp(by, 0, frame.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

// True when the rectangle is too small to save, under D-170's 24pt drag.
export function isTooSmall(rect: PointRect): boolean {
  'worklet';
  return Math.hypot(rect.width, rect.height) < MIN_DRAG;
}

// The rectangle moved by (dx, dy) and kept whole on the photo.
export function moveWithin(rect: PointRect, dx: number, dy: number, frame: Size): PointRect {
  'worklet';
  return {
    x: clamp(rect.x + dx, 0, Math.max(0, frame.width - rect.width)),
    y: clamp(rect.y + dy, 0, Math.max(0, frame.height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

export type Corner = 0 | 1 | 2 | 3;

// The corner order is top-left, top-right, bottom-right, bottom-left.
export function cornerPoint(rect: PointRect, corner: Corner): { x: number; y: number } {
  'worklet';
  const right = corner === 1 || corner === 2;
  const bottom = corner === 2 || corner === 3;
  return { x: right ? rect.x + rect.width : rect.x, y: bottom ? rect.y + rect.height : rect.y };
}

// The corner whose handle the point is on, or -1.
export function cornerAt(rect: PointRect, px: number, py: number): Corner | -1 {
  'worklet';
  for (let corner = 0; corner < 4; corner += 1) {
    const point = cornerPoint(rect, corner as Corner);
    if (Math.abs(px - point.x) <= HANDLE_REACH && Math.abs(py - point.y) <= HANDLE_REACH) {
      return corner as Corner;
    }
  }
  return -1;
}

export function contains(rect: PointRect, px: number, py: number): boolean {
  'worklet';
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}

// The rectangle as fractions of the photo, which is what the API stores (D-99). The far edges are
// computed from the near ones and capped at 1, so rounding cannot make `x + width` come out a hair
// above 1 and draw a 400 (shared-types blur-region.ts). Null when it has no area left.
export function toFractions(rect: PointRect, frame: Size): BlurRect | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const x = clamp(rect.x / frame.width, 0, 1);
  const y = clamp(rect.y / frame.height, 0, 1);
  const right = clamp((rect.x + rect.width) / frame.width, 0, 1);
  const bottom = clamp((rect.y + rect.height) / frame.height, 0, 1);
  const width = Math.min(right - x, 1 - x);
  const height = Math.min(bottom - y, 1 - y);
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

// A stored region drawn on the photo as it sits on screen.
export function fromFractions(rect: BlurRect, frame: Size): PointRect {
  return {
    x: rect.x * frame.width,
    y: rect.y * frame.height,
    width: rect.width * frame.width,
    height: rect.height * frame.height,
  };
}
