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
export function nativePictureSize(sizes: readonly string[]): string | null {
  return (
    sizes.filter((size) => /^\d+x\d+$/.test(size)).sort((a, b) => area(b) - area(a))[0] ?? null
  );
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
