export class CameraReadiness {
  private ready = false;
  private waiters = new Set<(error?: Error) => void>();

  isReady() {
    return this.ready;
  }
  setReady(ready: boolean) {
    this.ready = ready;
    if (ready) for (const finish of this.waiters) finish();
  }
  wait(timeoutMs = 15_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(new Error('The camera is still starting. Wait for the preview and try again.')),
        timeoutMs,
      );
      this.waiters.add(finish);
    });
  }
  cancel() {
    this.ready = false;
    for (const finish of this.waiters)
      finish(new Error('The camera closed before it could take the photo.'));
  }
}
