import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  BACKGROUND_UPLOAD_TASK,
  backgroundUploadTask,
  registerBackgroundHold,
} from '@/features/upload-queue/background-task';

// The Headless JS task Android's service starts (D-158). It may run in a process whose app never
// started uploads, so it must do nothing there: no upload, no prompt, no wait.
const mockRequest = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockRequest(),
  requestPermissionsAsync: () => mockRequest(),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await settle();
  return done;
}

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe('the Android Headless JS task', () => {
  it('has the name the native service starts', () => {
    expect(BACKGROUND_UPLOAD_TASK).toBe('MomentLensBackgroundUpload');
  });

  it('finishes at once when nothing registered a hold, as in a cold start', async () => {
    expect(await settled(backgroundUploadTask({ taskId: 'task-1' }))).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { taskId: 7 }, { taskId: '' }])(
    'finishes at once for task data %p',
    async (data) => {
      const hold = jest.fn(() => new Promise<void>(() => undefined));
      unregister = registerBackgroundHold(hold);
      expect(await settled(backgroundUploadTask(data))).toBe(true);
      expect(hold).not.toHaveBeenCalled();
    },
  );

  it('waits on the registered hold for its own task id, and never prompts', async () => {
    let release!: () => void;
    const hold = jest.fn(
      (_taskId: string) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    unregister = registerBackgroundHold(hold);
    const task = backgroundUploadTask({ taskId: 'task-1' });
    expect(await settled(task)).toBe(false);
    expect(hold).toHaveBeenCalledWith('task-1');
    release();
    expect(await settled(task)).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('a newer registration replaces the old one, and the old unregister leaves it alone', async () => {
    const first = jest.fn(async (_taskId: string) => undefined);
    const second = jest.fn(async (_taskId: string) => undefined);
    const removeFirst = registerBackgroundHold(first);
    unregister = registerBackgroundHold(second);
    removeFirst();
    await backgroundUploadTask({ taskId: 'task-1' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('task-1');
  });

  it('finishes instead of failing when the hold throws', async () => {
    unregister = registerBackgroundHold(() => {
      throw new Error('broken');
    });
    await expect(backgroundUploadTask({ taskId: 'task-1' })).resolves.toBeUndefined();
  });
});
