import type { ShotContext } from './context';

export interface CaptureDependencies {
  userId(): string | null;
  makeId(): string;
  permission(): Promise<boolean>;
  exclude(): Promise<void>;
  take(): Promise<string>;
  persist(id: string, shot: ShotContext, uri: string): Promise<void>;
  claimGallery(owner: string, id: string, explicit: boolean): Promise<boolean>;
  saveGallery(owner: string, id: string): Promise<void>;
  galleryResult(owner: string, id: string, saved: boolean): Promise<void>;
  handoff(owner: string, id: string): Promise<void>;
  discardTemporary(uri: string): Promise<void>;
}
export class CaptureController {
  private busy = false;
  constructor(private deps: CaptureDependencies) {}
  private check(owner: string) {
    if (this.deps.userId() !== owner) throw new Error('The signed-in account changed.');
  }
  async capture(shot: ShotContext): Promise<{ id: string; durable: boolean; queued: boolean }> {
    if (this.busy) throw new Error('A capture is in progress.');
    this.busy = true;
    let uri: string | undefined;
    try {
      this.check(shot.userId);
      if (shot.mode === 'public') {
        const granted = await this.deps.permission();
        this.check(shot.userId);
        if (!granted)
          throw new Error(
            'Public photos need permission to save to your gallery. You can use Local Only.',
          );
      }
      await this.deps.exclude();
      this.check(shot.userId);
      uri = await this.deps.take();
      this.check(shot.userId);
      const id = this.deps.makeId();
      try {
        await this.deps.persist(id, shot, uri);
      } catch {
        throw new Error(
          'The photo could not be saved on this phone. Check free space and try again.',
        );
      }
      // Durable writes keep the frozen owner even if the account changed while saving.
      if (shot.mode === 'local_only' || this.deps.userId() !== shot.userId)
        return { id, durable: true, queued: false };
      const queued = await this.finishPublic(shot.userId, id, false).catch(() => false);
      return { id, durable: true, queued };
    } finally {
      if (uri) await this.deps.discardTemporary(uri).catch(() => undefined);
      this.busy = false;
    }
  }
  async finishPublic(owner: string, id: string, explicit: boolean): Promise<boolean> {
    this.check(owner);
    if (explicit) {
      const allowed = await this.deps.permission();
      this.check(owner);
      if (!allowed) return false;
    }
    const claimed = await this.deps.claimGallery(owner, id, explicit);
    if (!claimed) return false;
    if (this.deps.userId() !== owner) {
      await this.deps.galleryResult(owner, id, false);
      return false;
    }
    try {
      await this.deps.saveGallery(owner, id);
    } catch {
      await this.deps.galleryResult(owner, id, false);
      return false;
    }
    await this.deps.galleryResult(owner, id, true);
    if (this.deps.userId() !== owner) return false;
    try {
      await this.deps.handoff(owner, id);
      return true;
    } catch {
      return false;
    } // Gallery success is durable; My Media retries only the handoff.
  }
}
