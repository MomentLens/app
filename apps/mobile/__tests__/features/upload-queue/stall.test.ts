import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { stallGuard } from '@/features/upload-queue/stall';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('a PUT cancelled only when it stops making progress (D-146)', () => {
  it('aborts after the limit with no progress', () => {
    const guard = stallGuard(new AbortController().signal, 120_000);
    jest.advanceTimersByTime(119_999);
    expect(guard.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
  });

  it('waits the limit again from each progress report, so a slow upload that keeps sending finishes', () => {
    const guard = stallGuard(new AbortController().signal, 120_000);
    for (let minute = 0; minute < 10; minute++) {
      jest.advanceTimersByTime(60_000);
      guard.progress();
    }
    expect(guard.signal.aborted).toBe(false);
    guard.dispose();
  });

  it("aborts with the caller's signal, and stops listening once disposed", () => {
    const caller = new AbortController();
    const guard = stallGuard(caller.signal, 120_000);
    caller.abort();
    expect(guard.signal.aborted).toBe(true);

    const later = new AbortController();
    const disposed = stallGuard(later.signal, 120_000);
    disposed.dispose();
    later.abort();
    jest.advanceTimersByTime(120_000);
    expect(disposed.signal.aborted).toBe(false);
  });
});
