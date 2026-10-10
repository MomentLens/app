import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';

export type CaptureMode = 'public' | 'local_only';
export interface ShotContext {
  readonly userId: string;
  readonly eventId: string;
  readonly subEventId: string;
  readonly mode: CaptureMode;
  readonly capturedAt: string;
}
export function admitShot(
  userId: string | null,
  eventId: string,
  schedule: readonly Pick<SubEvent, 'id' | 'startsAt' | 'endsAt'>[],
  mode: CaptureMode,
  at: Date,
  accessible: boolean,
): ShotContext | null {
  const live = currentSubEvent(schedule, at);
  return userId && accessible && live
    ? Object.freeze({ userId, eventId, subEventId: live.id, mode, capturedAt: at.toISOString() })
    : null;
}
// Android only. Expo Camera's CameraX selector prefers 4:3 and treats pictureSize as an upper
// bound, so a larger sensor-shaped size such as 3440x2448 binds as 3264x2448. Request the
// 4:3 output that will bind; fall back to the largest size when a camera has no 4:3 output.
export function nativePictureSize(sizes: readonly string[]): string | null {
  const valid = sizes.filter((size) => /^\d+x\d+$/.test(size)).sort((a, b) => area(b) - area(a));
  return valid.find((size) => matchesShape(size, 4, 3)) ?? valid[0] ?? null;
}
export function matchesShape(size: string, width: number, height: number): boolean {
  const [w, h] = size.split('x').map(Number);
  return Math.abs(shape(w!, h!) - shape(width, height)) <= 0.005;
}
function shape(width: number, height: number): number {
  return Math.min(width, height) / Math.max(width, height);
}
function area(size: string): number {
  const [width, height] = size.split('x').map(Number);
  return width! * height!;
}
export function fitPreview(size: string, width: number, height: number) {
  const [w, h] = size.split('x').map(Number);
  const ratio = Math.min(w!, h!) / Math.max(w!, h!);
  const fittedWidth = Math.min(width, height * ratio);
  return { width: fittedWidth, height: fittedWidth / ratio };
}
