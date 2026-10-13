import { NativeModule, requireOptionalNativeModule } from 'expo';

// Native protection for the upload runner (D-158). iOS begins a finite background task; Android
// starts a dataSync foreground service with one Headless JS task. Only a task id crosses in.
// features/upload-queue/background.ts decides when to call these.

export type EndReason = 'expired' | 'timeout' | 'refused' | 'stopped';

type Events = {
  // The system ended the task on its own. Native protection is already gone when this arrives.
  onEnded(event: { taskId: string; reason: EndReason }): void;
};

declare class BackgroundUploadModule extends NativeModule<Events> {
  start(taskId: string): Promise<boolean>;
  stop(taskId: string): Promise<void>;
}

// Null in a build made before S-14. Uploads then run in the foreground only, and My Media says so.
const native = requireOptionalNativeModule<BackgroundUploadModule>('BackgroundUpload');

export async function startProtection(taskId: string): Promise<boolean> {
  return native ? native.start(taskId) : false;
}

export async function stopProtection(taskId: string): Promise<void> {
  await native?.stop(taskId);
}

export function addEndedListener(
  listener: (taskId: string, reason: EndReason) => void,
): () => void {
  const subscription = native?.addListener('onEnded', ({ taskId, reason }) =>
    listener(taskId, reason),
  );
  return () => subscription?.remove();
}
