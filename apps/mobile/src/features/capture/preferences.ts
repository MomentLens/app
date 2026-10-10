import type { CaptureMode } from './context';

export function startingMode(value: string | undefined): CaptureMode {
  return value === 'local_only' ? 'local_only' : 'public';
}
export const noticeKey = (userId: string) => `localOnlyNotice/${userId}`;
