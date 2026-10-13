import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  askNotificationsOnce,
  BackgroundCoordinator,
  keepOpenAdvice,
  type NativeProtection,
  type ProtectedRunner,
} from '@/features/upload-queue/background';
import type { QueueCounts } from '@/features/upload-queue/types';

// The coordinator against a fake native module and a fake runner, so each test can say when the
// system answers and in what order (D-158). runner.test.ts drives suspension on a real store.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await settle();
  return done;
}

let calls: string[];
let user: string | null;
let starts: { taskId: string; args: unknown[]; answer: ReturnType<typeof deferred<boolean>> }[];
let nextId: number;
let asked: number;
let native: NativeProtection;
let runner: ProtectedRunner;

function create(visible = true, ask = true) {
  return new BackgroundCoordinator(
    {
      native,
      runner,
      userId: () => user,
      makeId: () => `task-${++nextId}`,
      ...(ask
        ? {
            askNotifications: async () => {
              asked++;
              calls.push('ask');
            },
          }
        : {}),
    },
    visible,
  );
}
// Starts a task for A in the foreground and lets the system grant it.
async function granted(coordinator: BackgroundCoordinator) {
  coordinator.activity('A', 'uploading');
  const start = starts.at(-1)!;
  start.answer.resolve(true);
  await settle();
  return start.taskId;
}

beforeEach(() => {
  calls = [];
  user = 'A';
  starts = [];
  nextId = 0;
  asked = 0;
  native = {
    start: (...args: [string]) => {
      const answer = deferred<boolean>();
      starts.push({ taskId: args[0], args, answer });
      calls.push(`start ${args[0]}`);
      return answer.promise;
    },
    stop: async (taskId) => {
      calls.push(`stop ${taskId}`);
    },
  };
  runner = {
    suspend: () => {
      calls.push('suspend');
    },
    resume: () => {
      calls.push('resume');
    },
    retryNow: async () => {
      calls.push('retryNow');
    },
    accountChanged: async () => {
      calls.push('accountChanged');
    },
  };
});

describe('one native task for the signed-in account', () => {
  it('starts one task when work begins in the foreground, passing only its id', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    coordinator.activity('A', 'uploading');
    coordinator.activity('A', 'backoff');
    coordinator.foreground();
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(1);
    // No account id, photo, event, path, URL or token crosses into native code.
    expect(starts[0]!.args).toEqual(['task-1']);
    starts[0]!.answer.resolve(true);
    await settle();
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(1);
  });

  it('starts nothing for an empty queue, a closed gate or a 401', () => {
    const coordinator = create();
    for (const activity of ['idle', 'offline', 'cellular', 'session', 'error'] as const)
      coordinator.activity('A', activity);
    expect(starts).toEqual([]);
  });

  it('ignores a report about another account', () => {
    const coordinator = create();
    coordinator.activity('B', 'uploading');
    expect(starts).toEqual([]);
  });

  it('never starts a task in the background', () => {
    const coordinator = create(false);
    coordinator.activity('A', 'uploading');
    expect(starts).toEqual([]);
  });
});

describe('keeping and ending protection', () => {
  it('keeps the task and its Headless JS hold across backoff', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    const hold = coordinator.hold(taskId);
    coordinator.activity('A', 'backoff');
    coordinator.background();
    coordinator.activity('A', 'backoff');
    coordinator.activity('A', 'uploading');
    expect(await settled(hold)).toBe(false);
    expect(calls).not.toContain('suspend');
    expect(calls).not.toContain(`stop ${taskId}`);
  });

  it.each(['idle', 'offline', 'cellular', 'session', 'error'] as const)(
    'ends the task when the runner reports %s, and suspends it in the background',
    async (activity) => {
      const coordinator = create();
      const taskId = await granted(coordinator);
      const hold = coordinator.hold(taskId);
      coordinator.background();
      coordinator.activity('A', activity);
      expect(await settled(hold)).toBe(true);
      expect(calls.slice(-2)).toEqual([`stop ${taskId}`, 'suspend']);
    },
  );

  it('ends the task in the foreground without suspending the runner', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    coordinator.activity('A', 'idle');
    expect(calls).toContain(`stop ${taskId}`);
    expect(calls).not.toContain('suspend');
  });

  it('suspends at once on background entry with no task, and keeps backoff', () => {
    const coordinator = create();
    coordinator.background();
    expect(calls).toEqual(['suspend']);
  });

  it('starts suspended when created in the background, then resumes and retries on the foreground', () => {
    const coordinator = create(false);
    coordinator.foreground();
    expect(calls).toEqual(['suspend', 'resume', 'retryNow']);
  });

  it('a wake after protection ended cannot restart it in the background', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    coordinator.background();
    coordinator.ended(taskId, 'expired');
    coordinator.activity('A', 'uploading');
    coordinator.activity('A', 'backoff');
    expect(starts).toHaveLength(1);
    coordinator.foreground();
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(2);
  });
});

describe('native expiry, timeout and refusal', () => {
  it.each(['expired', 'timeout', 'stopped'] as const)(
    '%s in the background releases the hold and suspends, without asking native to stop',
    async (reason) => {
      const coordinator = create();
      const taskId = await granted(coordinator);
      const hold = coordinator.hold(taskId);
      coordinator.background();
      coordinator.ended(taskId, reason);
      expect(await settled(hold)).toBe(true);
      expect(calls.at(-1)).toBe('suspend');
      expect(calls).not.toContain(`stop ${taskId}`);
    },
  );

  it('ignores an older task’s callback, so it cannot end or suspend the current one', async () => {
    const coordinator = create();
    const first = await granted(coordinator);
    coordinator.activity('A', 'idle');
    const second = await granted(coordinator);
    const hold = coordinator.hold(second);
    coordinator.background();
    coordinator.ended(first, 'expired');
    coordinator.ended('task-unknown', 'timeout');
    expect(await settled(hold)).toBe(false);
    expect(calls).not.toContain('suspend');
  });

  it('a hold for an older or unknown task resolves at once', async () => {
    const coordinator = create();
    const first = await granted(coordinator);
    coordinator.activity('A', 'idle');
    await granted(coordinator);
    expect(await settled(coordinator.hold(first))).toBe(true);
    expect(await settled(coordinator.hold('task-unknown'))).toBe(true);
  });

  it('a refused start keeps foreground uploads going and advises that account only', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    starts[0]!.answer.resolve(false);
    await settle();
    expect(calls).not.toContain('suspend');
    expect(coordinator.refusedFor()).toBe('A');
    // No retry loop while the app stays in the foreground.
    coordinator.activity('A', 'backoff');
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(1);

    coordinator.background();
    expect(calls.at(-1)).toBe('suspend');
    coordinator.foreground();
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(2);
    starts[1]!.answer.resolve(true);
    await settle();
    expect(coordinator.refusedFor()).toBeNull();
  });

  it('a refusal Android reports after the start gives the same advice', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    coordinator.ended(taskId, 'refused');
    expect(coordinator.refusedFor()).toBe('A');
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(1);
  });

  it('a start refused after the app went to the background suspends the runner', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    coordinator.background();
    expect(calls).not.toContain('suspend');
    starts[0]!.answer.resolve(false);
    await settle();
    expect(calls.at(-1)).toBe('suspend');
  });

  it('a native module that throws counts as a refusal', async () => {
    native.start = async () => {
      throw new Error('missing');
    };
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    await settle();
    expect(coordinator.refusedFor()).toBe('A');
  });

  it('tells subscribers when the advice changes', async () => {
    const coordinator = create();
    let changes = 0;
    const unsubscribe = coordinator.subscribe(() => {
      changes++;
    });
    coordinator.activity('A', 'uploading');
    starts[0]!.answer.resolve(false);
    await settle();
    expect(changes).toBe(1);
    unsubscribe();
    coordinator.accountChanged();
    expect(changes).toBe(1);
  });
});

describe('account changes', () => {
  it('ends the old task and releases its hold before the new account runs', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    const hold = coordinator.hold(taskId);
    user = 'B';
    coordinator.accountChanged();
    expect(await settled(hold)).toBe(true);
    expect(calls.slice(-2)).toEqual([`stop ${taskId}`, 'accountChanged']);
    coordinator.activity('A', 'uploading');
    expect(starts).toHaveLength(1);
    coordinator.activity('B', 'uploading');
    expect(starts).toHaveLength(2);
  });

  it('suspends before the new account can run in the background', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    coordinator.background();
    user = 'B';
    coordinator.accountChanged();
    expect(calls.slice(-3)).toEqual([`stop ${taskId}`, 'suspend', 'accountChanged']);
  });

  it('stops a start that the system granted after the account changed, and never adopts it', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    user = 'B';
    coordinator.accountChanged();
    starts[0]!.answer.resolve(true);
    await settle();
    expect(calls).toContain('stop task-1');
    const hold = coordinator.hold('task-1');
    expect(await settled(hold)).toBe(true);
  });

  it('drops the previous account’s advice', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    starts[0]!.answer.resolve(false);
    await settle();
    user = 'B';
    coordinator.accountChanged();
    expect(coordinator.refusedFor()).toBeNull();
  });
});

describe('Android notification permission (D-158)', () => {
  it('asks after the first granted start in the foreground, and the start never waits for it', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    expect(asked).toBe(0);
    starts[0]!.answer.resolve(true);
    await settle();
    expect(asked).toBe(1);
    expect(calls.indexOf('start task-1')).toBeLessThan(calls.indexOf('ask'));
  });

  it('never asks for a refused start, or for a start granted after the app left the foreground', async () => {
    const coordinator = create();
    coordinator.activity('A', 'uploading');
    starts[0]!.answer.resolve(false);
    await settle();
    coordinator.background();
    coordinator.foreground();
    coordinator.activity('A', 'uploading');
    coordinator.background();
    starts[1]!.answer.resolve(true);
    await settle();
    expect(asked).toBe(0);
  });

  it('never asks from the Headless JS hold', async () => {
    const coordinator = create(true, true);
    const taskId = await granted(coordinator);
    asked = 0;
    await settled(coordinator.hold(taskId));
    expect(asked).toBe(0);
  });

  function device(status: 'granted' | 'denied' | 'undetermined', canAskAgain = true) {
    const state = { asked: false, prompts: 0 };
    return {
      state,
      deps: {
        android: true,
        asked: () => state.asked,
        markAsked: () => {
          state.asked = true;
        },
        current: async () => ({ granted: status === 'granted', canAskAgain }),
        request: async () => {
          state.prompts++;
        },
      },
    };
  }

  it('prompts once per device, marking it asked before the prompt', async () => {
    const { state, deps } = device('undetermined');
    let markedFirst = false;
    await askNotificationsOnce({
      ...deps,
      request: async () => {
        markedFirst = state.asked;
        state.prompts++;
      },
    });
    await askNotificationsOnce(deps);
    expect(state.prompts).toBe(1);
    expect(markedFirst).toBe(true);
  });

  it('never prompts after a denial, once granted, or on iOS', async () => {
    for (const [status, canAskAgain] of [
      ['denied', false],
      ['granted', true],
    ] as const) {
      const { state, deps } = device(status, canAskAgain);
      await askNotificationsOnce(deps);
      expect(state.prompts).toBe(0);
    }
    const ios = device('undetermined');
    await askNotificationsOnce({ ...ios.deps, android: false });
    expect(ios.state.prompts).toBe(0);
  });
});

describe('the keep-open advice in My Media', () => {
  const counts = (queued: number, uploading: number, waiting = 0): QueueCounts => ({
    queued,
    uploading,
    waitingAlbum: waiting,
    waitingVerification: waiting,
  });

  it('shows only for the refused account, while this event has photos queued or uploading', () => {
    expect(keepOpenAdvice('A', 'A', counts(1, 0))).toBe(true);
    expect(keepOpenAdvice('A', 'A', counts(0, 1))).toBe(true);
    expect(keepOpenAdvice('A', 'B', counts(3, 1))).toBe(false);
    expect(keepOpenAdvice(null, 'A', counts(3, 1))).toBe(false);
    expect(keepOpenAdvice('A', null, counts(3, 1))).toBe(false);
  });

  it('stays hidden for photos that wait, are stopped, finished or Local Only', () => {
    // Waiting photos count; stopped, finished and Local Only rows never reach the counts.
    expect(keepOpenAdvice('A', 'A', counts(0, 0, 4))).toBe(false);
  });
});

describe('shutdown', () => {
  it('ends the task and releases its hold, and nothing starts afterwards', async () => {
    const coordinator = create();
    const taskId = await granted(coordinator);
    const hold = coordinator.hold(taskId);
    coordinator.shutdown();
    expect(await settled(hold)).toBe(true);
    expect(calls).toContain(`stop ${taskId}`);
    coordinator.activity('A', 'uploading');
    coordinator.foreground();
    expect(starts).toHaveLength(1);
  });
});
