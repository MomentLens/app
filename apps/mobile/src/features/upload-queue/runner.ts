import type {
  CompleteUploadResponse,
  PreflightUploadRequest,
  PreflightUploadResponse,
} from '@momentlens/shared-types';

import type { PreparedUpload } from './prepare';
import type { QueueStore } from './store';
import {
  backoffDelay,
  MAX_PREPARE_ATTEMPTS,
  RUNNER_PAUSE_MS,
  transitionFor,
  type Call,
  type Transition,
} from './transitions';
import type { QueueItem, StoppedReason } from './types';

// The upload loop, a human-read surface (D-68, D-97). One runner moves photos one at a time,
// oldest first across every event, for the signed-in account only. S-14's background task calls
// the same runner (D-146). Every native call comes in through RunnerDeps, so tests drive this file
// against a real SQLite store; queue.ts supplies the app's.

export type PutResult = 'ok' | 'failed' | 'missing';
// `cellular` means cellular while "Upload over Mobile Data" is off.
export type NetworkGate = 'open' | 'offline' | 'cellular';

// While "Upload over Mobile Data" is off, only Wi-Fi and Ethernet are open (D-146). Cellular behind
// a VPN reports `VPN`, and a network the phone cannot name reports `UNKNOWN` or nothing, so all of
// them wait. `networkType` is expo-network's NetworkStateType.
export function gateFor(
  online: boolean,
  mobileData: boolean,
  networkType: string | undefined,
): NetworkGate {
  if (!online) return 'offline';
  if (mobileData) return 'open';
  return networkType === 'WIFI' || networkType === 'ETHERNET' ? 'open' : 'cellular';
}

export interface RunnerDeps {
  store(): Promise<QueueStore>;
  // The signed-in account, read again before every write.
  userId(): string | null;
  prepare(item: QueueItem): Promise<PreparedUpload>;
  // Deletes a prepared file whose photo My Media deleted during Stage 1.
  discard(path: string): Promise<void>;
  preflight(
    userId: string,
    eventId: string,
    body: PreflightUploadRequest,
    signal: AbortSignal,
  ): Promise<PreflightUploadResponse>;
  complete(userId: string, mediaId: string, signal: AbortSignal): Promise<CompleteUploadResponse>;
  // A PUT of a queue file to R2. `missing` when the file is not on disk.
  put(path: string, url: string, contentType: string, signal: AbortSignal): Promise<PutResult>;
  gate(): Promise<NetworkGate>;
  // A 403 or 404 means the caller's place in the event changed. The Event shell checks again.
  lostAccess(eventId: string): void;
  now(): number;
  schedule(wake: () => void, delayMs: number): () => void;
  warn?(message: string, error: unknown): void;
}

// How one attempt ended for the pass that made it.
// - next: the photo moved on, or waits on its own backoff. The pass takes the next photo.
// - outage: no answer. The whole runner pauses, so an outage meets one photo, not all of them.
// - session: a 401. The runner waits for the session, the foreground or a reconnect.
// - cancelled: the account changed. Nothing was written.
type Attempt = 'next' | 'outage' | 'session' | 'cancelled';
// How a pass ended, which decides whether a timer wakes the runner.
type Pass = 'idle' | 'paused' | 'blocked';

const PHOTO_TYPE = 'image/jpeg';
const THUMBNAIL_TYPE = 'image/webp';

export class UploadRunner {
  private running: Promise<void> | null = null;
  private again = false;
  // The next pass clears every backoff first, so each photo is tried once now. Foreground,
  // reconnect and a release ask for one.
  private fresh = false;
  // Photos whose attempt threw on a queue write this round. Each keeps the state the last write
  // left, which may still be due, so without this the pass would pick it again at once.
  private failed = new Set<string>();
  private stopped = false;
  private owner: string | null = null;
  private pausedUntil = 0;
  private controller: AbortController | null = null;
  private cancelTimer: (() => void) | null = null;

  constructor(private deps: RunnerDeps) {}

  // Starts a pass, or asks the running one for another. Resolves once the runner is idle.
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
      // A run() that landed after the loop's last look at `again` found `running` still set.
      // It gets its pass here, and whoever awaits this promise waits for that pass too.
      return this.again ? this.run() : undefined;
    });
    return this.running;
  }

  // Foreground, reconnect, a release or a refreshed session: every photo is tried once now,
  // whatever its backoff (D-146).
  retryNow(): Promise<void> {
    this.fresh = true;
    this.pausedUntil = 0;
    return this.run();
  }

  // The signed-in account changed. The current attempt is cancelled, its PUT included, and writes
  // nothing more (D-146). The next pass belongs to the new account.
  accountChanged(): Promise<void> {
    this.controller?.abort();
    return this.retryNow();
  }

  // Stops the runner for good. The current attempt is cancelled as an account change cancels it,
  // and no pass or timer starts again. queue.ts calls it when Fast Refresh replaces this runner.
  shutdown(): void {
    this.stopped = true;
    this.controller?.abort();
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private async loop(): Promise<void> {
    for (;;) {
      this.again = false;
      this.cancelTimer?.();
      this.cancelTimer = null;
      if (this.stopped) return;
      const userId = this.deps.userId();
      if (userId === null) return;
      if (userId !== this.owner) {
        this.owner = userId;
        this.failed.clear();
        this.pausedUntil = 0;
      }
      const fresh = this.fresh;
      this.fresh = false;
      if (fresh) this.failed.clear();
      let pass: Pass;
      if (!fresh && this.deps.now() < this.pausedUntil) {
        pass = 'paused';
      } else {
        const controller = new AbortController();
        this.controller = controller;
        try {
          pass = await this.pass(userId, controller.signal, fresh);
        } catch (error) {
          // The queue database failed. The next foreground or reconnect tries again.
          this.deps.warn?.('The upload queue could not run', error);
          pass = 'blocked';
        }
      }
      if (this.again) continue;
      await this.wakeLater(userId, pass);
      if (!this.again || this.stopped) return;
    }
  }

  private async wakeLater(userId: string, pass: Pass): Promise<void> {
    let at: number | null = null;
    if (pass === 'paused') {
      at = this.pausedUntil;
    } else if (pass === 'idle') {
      try {
        at = await (await this.deps.store()).nextWake(userId, this.deps.now());
      } catch {
        at = null;
      }
    }
    if (at === null || this.stopped || this.deps.userId() !== userId) return;
    this.cancelTimer = this.deps.schedule(
      () => {
        this.cancelTimer = null;
        // A new round gives a photo whose queue write failed another try.
        this.failed.clear();
        void this.run();
      },
      Math.max(0, at - this.deps.now()),
    );
  }

  private live(userId: string, signal: AbortSignal): boolean {
    return !signal.aborted && !this.stopped && this.deps.userId() === userId;
  }

  // Every attempt that returns `next` leaves its photo settled or backing off past now, so the
  // pass never picks it twice without a skip list. Only a thrown queue write needs one.
  private async pass(userId: string, signal: AbortSignal, fresh: boolean): Promise<Pass> {
    const store = await this.deps.store();
    // Nothing is in flight between passes, so a photo still uploading was left by a kill or by an
    // account change.
    await store.recover(userId);
    // Foreground, reconnect or a release makes every photo due now. Its count keeps the next
    // failure's backoff where it was (D-146).
    if (fresh) await store.clearBackoff(userId);
    for (;;) {
      if (!this.live(userId, signal)) return 'idle';
      if ((await this.deps.gate()) !== 'open') return 'blocked';
      const item = await store.nextUpload(userId, this.deps.now(), [...this.failed]);
      if (!item) return 'idle';
      let attempt: Attempt;
      try {
        attempt = await this.attempt(store, item, signal);
      } catch (error) {
        // A failed queue write. The photo stays as the last write left it, and waits for the
        // next round.
        this.deps.warn?.('An upload attempt failed', error);
        this.failed.add(item.id);
        continue;
      }
      if (attempt === 'outage') {
        this.pausedUntil = this.deps.now() + RUNNER_PAUSE_MS;
        return 'paused';
      }
      if (attempt === 'session') return 'blocked';
      if (attempt === 'cancelled') return 'idle';
    }
  }

  private async attempt(store: QueueStore, item: QueueItem, signal: AbortSignal): Promise<Attempt> {
    let row = item;
    if (row.step === 'prepare') {
      const prepared = await this.prepare(store, row);
      if (prepared === null) return 'next';
      row = prepared;
      // The same photo queued twice hashes the same. While the other copy is in flight holding a
      // server row, this one waits, and nextUpload leaves it out. Pre-flight now would resume that
      // row and give My Media two photos for one upload. Once the other uploads, this pre-flight
      // answers duplicate.
      if (await store.waitsForTwin(row.userId, row.id)) return 'next';
    }
    if (row.step !== 'complete') {
      const sent = await this.send(store, row, signal);
      if (typeof sent === 'string') return sent;
      row = sent;
    }
    return this.complete(store, row, signal);
  }

  // Stage 1, once per photo. The attempt is counted before it starts, so a photo that kills the
  // app is counted too, and the third failed or interrupted attempt stops it (D-146). Stage 1 is
  // local, so an account change does not cancel it: its result belongs to the photo's own account.
  private async prepare(store: QueueStore, row: QueueItem): Promise<QueueItem | null> {
    const { userId, id } = row;
    if (row.photoPath === null || row.retryCount >= MAX_PREPARE_ATTEMPTS) {
      await this.stop(store, row, 'invalid_request');
      return null;
    }
    const attempts = row.retryCount + 1;
    if (!(await store.update(userId, id, { retryCount: attempts }, ['queued']))) return null;
    let prepared: PreparedUpload;
    try {
      prepared = await this.deps.prepare(row);
    } catch (error) {
      this.deps.warn?.('Stage 1 failed', error);
      if (attempts >= MAX_PREPARE_ATTEMPTS) {
        await this.stop(store, row, 'invalid_request');
      } else {
        await store.update(userId, id, { nextRetryAt: this.deps.now() + backoffDelay(attempts) }, [
          'queued',
        ]);
      }
      return null;
    }
    if (!(await store.prepared(userId, id, prepared.photoPath, prepared.contentHash))) {
      // My Media deleted the photo while Stage 1 ran.
      await this.deps.discard(prepared.photoPath).catch(() => undefined);
      return null;
    }
    return { ...row, ...prepared, step: 'preflight', retryCount: 0, nextRetryAt: null };
  }

  // Pre-flight, then both PUTs. Returns the row at step complete, or how the attempt ended.
  private async send(
    store: QueueStore,
    row: QueueItem,
    signal: AbortSignal,
  ): Promise<QueueItem | Attempt> {
    const { userId, id } = row;
    if (row.contentHash === null || row.photoPath === null) {
      await this.stop(store, row, 'invalid_request');
      return 'next';
    }
    if (!this.live(userId, signal)) return 'cancelled';
    let upload: PreflightUploadResponse;
    try {
      upload = await this.deps.preflight(
        userId,
        row.eventId,
        {
          contentHash: row.contentHash,
          subEventId: row.subEventId,
          // Always a capture time, so the album sorts every photo by it (D-147).
          capturedAt: row.capturedAt ?? new Date(row.createdAt).toISOString(),
        },
        signal,
      );
    } catch (error) {
      if (!this.live(userId, signal)) return 'cancelled';
      return this.apply(store, row, 'preflight', transitionFor('preflight', error));
    }
    if (!this.live(userId, signal)) return 'cancelled';
    // The photo turns uploading only while it is still queued. My Media's Delete refuses an
    // uploading photo, so one of the two writes wins, and a deleted photo is never PUT (D-146).
    const claimed = await store.update(
      userId,
      id,
      { state: 'uploading', step: 'put_photo', mediaId: upload.mediaId, nextRetryAt: null },
      ['queued'],
    );
    if (!claimed) return 'next';
    const uploading: QueueItem = {
      ...row,
      state: 'uploading',
      step: 'put_photo',
      mediaId: upload.mediaId,
      nextRetryAt: null,
    };

    // Each file goes only to its own URL. The thumbnail is unblurred, so it goes to R2 and
    // nowhere else (root invariant 13).
    const photo = await this.deps.put(row.photoPath, upload.photoUploadUrl, PHOTO_TYPE, signal);
    if (photo !== 'ok') return this.putFailed(store, uploading, photo, signal);
    if (!this.live(userId, signal)) return 'cancelled';
    if (!(await store.update(userId, id, { step: 'put_thumbnail' }, ['uploading']))) return 'next';

    const thumbnail = await this.deps.put(
      row.thumbnailPath,
      upload.thumbnailUploadUrl,
      THUMBNAIL_TYPE,
      signal,
    );
    if (thumbnail !== 'ok') return this.putFailed(store, uploading, thumbnail, signal);
    if (!this.live(userId, signal)) return 'cancelled';
    // Stored before completion is sent, so a lost answer or a kill retries completion and never
    // pre-flight, which would send both files again (D-122).
    if (!(await store.update(userId, id, { step: 'complete' }, ['uploading']))) return 'next';
    return { ...uploading, step: 'complete' };
  }

  // A failed or timed-out PUT sends the photo back through pre-flight, which resumes its row with
  // fresh URLs, and both files go again (D-146). A PUT cancelled by an account change writes
  // nothing.
  private async putFailed(
    store: QueueStore,
    row: QueueItem,
    result: PutResult,
    signal: AbortSignal,
  ): Promise<Attempt> {
    if (!this.live(row.userId, signal)) return 'cancelled';
    if (result === 'missing') {
      // upload.jpg or the thumbnail is gone, and no other bytes match the stored hash.
      await this.stop(store, row, 'invalid_request');
      return 'next';
    }
    const failures = row.retryCount + 1;
    await store.update(
      row.userId,
      row.id,
      {
        state: 'queued',
        step: 'preflight',
        retryCount: failures,
        nextRetryAt: this.deps.now() + backoffDelay(failures),
      },
      ['uploading'],
    );
    return 'outage';
  }

  private async complete(store: QueueStore, row: QueueItem, signal: AbortSignal): Promise<Attempt> {
    const { userId, id } = row;
    if (row.mediaId === null) {
      await this.stop(store, row, 'invalid_request');
      return 'next';
    }
    if (!this.live(userId, signal)) return 'cancelled';
    try {
      await this.deps.complete(userId, row.mediaId, signal);
    } catch (error) {
      if (!this.live(userId, signal)) return 'cancelled';
      return this.apply(store, row, 'complete', transitionFor('complete', error));
    }
    if (!this.live(userId, signal)) return 'cancelled';
    // The photo stays in My Media with its thumbnail and media id, and the status read tells the
    // phone when it is published (D-145). The update deletes upload.jpg.
    await store.update(userId, id, { state: 'uploaded', retryCount: 0, nextRetryAt: null }, [
      'uploading',
    ]);
    return 'next';
  }

  // A refusal, moved as arch §4's table says. The photo keeps its step, so a photo stopped after
  // both files were sent retries completion once released (D-146).
  private async apply(
    store: QueueStore,
    row: QueueItem,
    call: Call,
    transition: Transition,
  ): Promise<Attempt> {
    const { userId, id } = row;
    switch (transition.type) {
      case 'cancel':
        return 'cancelled';
      case 'session':
        return 'session';
      case 'drop':
        await store.drop(userId, id);
        return 'next';
      case 'stop':
        await this.stop(store, row, transition.reason);
        return 'next';
      case 'wait':
        await store.update(
          userId,
          id,
          { state: transition.state, retryCount: 0, nextRetryAt: null },
          ['queued'],
        );
        return 'next';
      case 'resend': {
        const failures = row.retryCount + 1;
        await store.update(
          userId,
          id,
          {
            state: 'queued',
            step: 'preflight',
            retryCount: failures,
            nextRetryAt: this.deps.now() + backoffDelay(failures),
          },
          ['uploading'],
        );
        return 'next';
      }
      case 'retry': {
        const failures = row.retryCount + 1;
        await store.update(
          userId,
          id,
          { retryCount: failures, nextRetryAt: this.deps.now() + backoffDelay(failures) },
          [call === 'preflight' ? 'queued' : 'uploading'],
        );
        return 'outage';
      }
    }
  }

  private async stop(store: QueueStore, row: QueueItem, reason: StoppedReason): Promise<void> {
    await store.update(
      row.userId,
      row.id,
      { state: 'stopped', stoppedReason: reason, nextRetryAt: null },
      [row.state],
    );
    if (reason === 'not_member' || reason === 'not_found') this.deps.lostAccess(row.eventId);
  }
}
