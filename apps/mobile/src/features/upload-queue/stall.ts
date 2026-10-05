// An abort signal for one PUT that fires once the upload has made no progress for `ms`, or when
// the caller's signal aborts (D-146). A slow link that keeps sending finishes; a dead one is cut
// off. Call progress() on each progress report, and dispose() once the PUT settles.
export function stallGuard(caller: AbortSignal, ms: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timer = setTimeout(abort, ms);
  if (caller.aborted) abort();
  caller.addEventListener('abort', abort);
  return {
    signal: controller.signal,
    progress() {
      clearTimeout(timer);
      timer = setTimeout(abort, ms);
    },
    dispose() {
      clearTimeout(timer);
      caller.removeEventListener('abort', abort);
    },
  };
}
