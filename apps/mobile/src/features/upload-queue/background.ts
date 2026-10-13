import type { RunnerActivity, UploadRunner } from './runner';
import type { QueueCounts } from './types';

// Keeps the one upload runner going in the background for as long as the system allows, part of
// the upload queue's human-read surface (D-68, D-158). The runner moves photos; this file decides
// when native protection starts and ends, and when the runner suspends.
//
// - Protection starts only while the app is visible and the runner has work it can do now or
//   after a backoff. iOS begins a finite background task; Android starts a dataSync foreground
//   service whose Headless JS task holds the JavaScript timers open (hold() below).
// - Protection ends when the runner goes quiet (idle, offline, waiting for Wi-Fi, a 401 or a
//   database failure), when the account changes, or when the system ends it. In the background
//   the runner then suspends, and nothing restarts it before the foreground.
// - Each task carries an id and belongs to the account that started it. A callback for any other
//   task changes nothing.

export type EndReason = 'expired' | 'timeout' | 'refused' | 'stopped';

export interface NativeProtection {
  // True once the system granted protection for this task. Only the task id crosses into native
  // code: no account, photo, event, path, URL or token.
  start(taskId: string): Promise<boolean>;
  stop(taskId: string): Promise<void>;
}

export type ProtectedRunner = Pick<
  UploadRunner,
  'suspend' | 'resume' | 'retryNow' | 'accountChanged'
>;

export interface CoordinatorDeps {
  native: NativeProtection;
  runner: ProtectedRunner;
  userId(): string | null;
  makeId(): string;
  // Android's notification prompt, asked once on this device (askNotificationsOnce).
  askNotifications?(): Promise<void>;
  warn?(message: string, error: unknown): void;
}

interface Task {
  id: string;
  userId: string;
  // False until the system answers start().
  granted: boolean;
  // Resolvers for Android's Headless JS task, which finishes when they run.
  holds: (() => void)[];
}

const WORKING: ReadonlySet<RunnerActivity> = new Set(['uploading', 'backoff']);

export class BackgroundCoordinator {
  private task: Task | null = null;
  // The runner's last report, for the account it named.
  private report: { userId: string; activity: RunnerActivity } | null = null;
  // Set by a refusal. No new start until the next foreground or account, so a system that keeps
  // refusing gets one request per foreground rather than one per report.
  private refused: string | null = null;
  private blocked = false;
  private stopped = false;
  private listeners = new Set<() => void>();

  constructor(
    private deps: CoordinatorDeps,
    private visible: boolean,
  ) {
    if (!visible) deps.runner.suspend();
  }

  // The runner's report after each pass, or as a pass picks a photo.
  activity(userId: string, activity: RunnerActivity): void {
    if (userId !== this.deps.userId()) return;
    this.report = { userId, activity };
    this.sync();
  }

  // The app became visible. The runner resumes and retries every photo at once (D-146).
  foreground(): void {
    if (this.stopped) return;
    this.visible = true;
    this.blocked = false;
    this.deps.runner.resume();
    void this.deps.runner.retryNow();
    this.sync();
  }

  // The app left the screen. Backoff stays as it is (D-158).
  background(): void {
    if (this.stopped) return;
    this.visible = false;
    this.sync();
  }

  // The signed-in account changed. The old account's task ends and its attempt is cancelled
  // before the new account runs, under its own eligibility (D-158).
  accountChanged(): void {
    if (this.stopped) return;
    this.end();
    this.report = null;
    this.blocked = false;
    this.setRefused(null);
    if (!this.visible) this.deps.runner.suspend();
    void this.deps.runner.accountChanged();
  }

  // The system ended a task on its own: iOS expiry, an Android timeout or shutdown, or a refusal
  // after the start. Native code has already dropped its protection, so this asks it for nothing.
  ended(taskId: string, reason: EndReason): void {
    const task = this.task;
    if (!task || task.id !== taskId) return;
    this.task = null;
    release(task);
    if (reason === 'refused') this.refuse(task.userId);
    this.sync();
  }

  // Android's Headless JS task waits on this, so React Native keeps JavaScript timers running in
  // the background while the task is current. It resolves at once for any other task, including
  // one started by a process that has since restarted.
  hold = (taskId: string): Promise<void> => {
    const task = this.task;
    if (!task || task.id !== taskId) return Promise.resolve();
    return new Promise((resolve) => {
      task.holds.push(resolve);
    });
  };

  // The account whose last start the system refused. My Media asks it to keep the app open.
  refusedFor = (): string | null => this.refused;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Fast Refresh replaces the queue module. The old coordinator ends its task and starts nothing.
  shutdown(): void {
    this.end();
    this.stopped = true;
  }

  private sync(): void {
    if (this.stopped) return;
    const userId = this.deps.userId();
    const working =
      userId !== null && this.report?.userId === userId && WORKING.has(this.report.activity);
    if (this.task && (!working || this.task.userId !== userId)) this.end();
    if (!this.task && working && this.visible && !this.blocked) void this.start(userId);
    // Background work needs a task. A start still waiting on the system counts, and its answer
    // runs sync() again.
    if (!this.visible && !this.task) {
      this.report = null;
      this.deps.runner.suspend();
    }
  }

  private async start(userId: string): Promise<void> {
    const task: Task = { id: this.deps.makeId(), userId, granted: false, holds: [] };
    this.task = task;
    let granted: boolean;
    try {
      granted = await this.deps.native.start(task.id);
    } catch (error) {
      this.deps.warn?.('Background upload protection could not start', error);
      granted = false;
    }
    if (this.task !== task) {
      // Ended or replaced while the system answered. A late grant is handed straight back.
      if (granted) void this.stopNative(task.id);
      return;
    }
    if (!granted) {
      this.task = null;
      this.refuse(userId);
      this.sync();
      return;
    }
    task.granted = true;
    this.setRefused(null);
    // After the start, so the service's notification channel exists and a dialog that pauses
    // the activity finds the task already running. Never from the background (D-158).
    if (this.visible) void this.deps.askNotifications?.().catch(() => undefined);
    this.sync();
  }

  // Ends the current task from this side: native protection stops and the hold releases.
  private end(): void {
    const task = this.task;
    if (!task) return;
    this.task = null;
    release(task);
    if (task.granted) void this.stopNative(task.id);
  }

  private async stopNative(taskId: string): Promise<void> {
    try {
      await this.deps.native.stop(taskId);
    } catch (error) {
      this.deps.warn?.('Background upload protection could not stop', error);
    }
  }

  private refuse(userId: string): void {
    this.blocked = true;
    this.setRefused(userId);
  }

  private setRefused(userId: string | null): void {
    if (this.refused === userId) return;
    this.refused = userId;
    for (const listener of this.listeners) listener();
  }
}

function release(task: Task): void {
  for (const resolve of task.holds.splice(0)) resolve();
}

// My Media asks the person to keep the app open only for the account whose start was refused, and
// only while this event has photos that would upload now: queued or uploading (D-158).
export function keepOpenAdvice(
  refusedFor: string | null,
  userId: string | null,
  counts: QueueCounts,
): boolean {
  return refusedFor !== null && refusedFor === userId && counts.queued + counts.uploading > 0;
}

export interface NotificationPrompt {
  android: boolean;
  asked(): boolean;
  markAsked(): void;
  current(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  request(): Promise<unknown>;
}

// Android 13 and later hide the service's notification until the person allows notifications. The
// app asks once on this device, and never again after a denial; denial blocks no upload (D-158).
// It is marked asked before the prompt, so a kill during the dialog cannot ask twice.
export async function askNotificationsOnce(prompt: NotificationPrompt): Promise<void> {
  if (!prompt.android || prompt.asked()) return;
  prompt.markAsked();
  const { granted, canAskAgain } = await prompt.current();
  if (granted || !canAskAgain) return;
  await prompt.request();
}
