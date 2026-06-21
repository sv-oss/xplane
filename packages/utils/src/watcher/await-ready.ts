import type { XrSnapshot } from './types.js';
import type { XrWatcher } from './xr-watcher.js';

export interface AwaitReadyOptions {
  /** Maximum time in ms to wait for `Ready=True` before rejecting. */
  timeoutMs?: number;
}

/**
 * Resolve when the watcher observes its first `Ready=True` snapshot. Rejects on
 * the watcher's first error, if the stream ends without becoming ready, or on
 * `timeoutMs`.
 *
 * Uses the watcher's dedicated `ready` promise — it does NOT consume queue
 * events, so it composes safely with a concurrent renderer iterating the
 * watcher.
 *
 * The watcher itself is not stopped on resolution — call `watcher.stop()` from
 * a `.finally()` if you want the underlying connections torn down.
 */
export async function awaitReady(
  watcher: XrWatcher,
  opts: AwaitReadyOptions = {},
): Promise<XrSnapshot> {
  if (opts.timeoutMs === undefined) return watcher.ready;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${opts.timeoutMs}ms waiting for Ready`)),
      opts.timeoutMs,
    );
  });
  try {
    return await Promise.race([watcher.ready, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
