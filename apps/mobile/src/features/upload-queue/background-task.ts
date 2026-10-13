// The Headless JS task that Android's background upload service starts (D-158). index.ts registers
// it. While it runs, React Native keeps JavaScript timers going in the background, so the runner's
// backoff and PUT-stall timers still fire. It moves no photo itself: it waits on the coordinator's
// hold for its task id, and the runner does the uploading.
//
// It never prompts, reads the queue or starts uploads. A process that Android started without the
// app, which START_NOT_STICKY and stopWithTask should prevent, has no hold registered, so the task
// finishes at once and the service stops.

export const BACKGROUND_UPLOAD_TASK = 'MomentLensBackgroundUpload';

// On globalThis, the one place a module replaced by Fast Refresh and its replacement both reach.
const HOLD = '__momentlensBackgroundUploadHold';
type Hold = (taskId: string) => Promise<void>;
type Global = typeof globalThis & { [HOLD]?: Hold };

// startUploads registers the coordinator's hold. The returned function removes it, unless a newer
// registration has replaced it.
export function registerBackgroundHold(hold: Hold): () => void {
  (globalThis as Global)[HOLD] = hold;
  return () => {
    if ((globalThis as Global)[HOLD] === hold) delete (globalThis as Global)[HOLD];
  };
}

export async function backgroundUploadTask(data: unknown): Promise<void> {
  const taskId =
    typeof data === 'object' && data !== null && 'taskId' in data ? data.taskId : undefined;
  const hold = (globalThis as Global)[HOLD];
  if (typeof taskId !== 'string' || !taskId || !hold) return;
  try {
    await hold(taskId);
  } catch {
    // A failed hold ends the task, and with it the service. The foreground resumes the queue.
  }
}
