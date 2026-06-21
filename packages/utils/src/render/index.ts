import type { XrRef } from '../watcher/types.js';
import type { XrWatcher } from '../watcher/xr-watcher.js';
import { renderCI } from './ci.js';
import { renderTTY } from './tty.js';

export { type CiRendererOptions, renderCI } from './ci.js';
export { formatEvent, formatHeader, formatProgress, statusGlyph } from './format.js';
export { renderTTY, type TtyRendererOptions } from './tty.js';

export type RendererMode = 'tty' | 'ci';

/** Auto-select a renderer based on whether the destination is an interactive TTY. */
export function selectRenderer(stream: NodeJS.WriteStream | NodeJS.WritableStream): RendererMode {
  const tty = stream as Partial<NodeJS.WriteStream>;
  return tty.isTTY ? 'tty' : 'ci';
}

export interface RunRendererOptions {
  ref: XrRef;
  /** Forces a renderer instead of auto-detecting. */
  mode?: RendererMode;
  /**
   * Destination stream. Defaults to `process.stdout`.
   * TTY mode requires a `NodeJS.WriteStream` (for `.rows`/`.columns`); pass
   * `mode: 'ci'` explicitly when piping to a plain `WritableStream`.
   */
  out?: NodeJS.WritableStream;
  /** Max number of recent events kept in the TTY tail. */
  eventTailSize?: number;
  /** CI: heartbeat interval (ms) for liveness lines. 0 disables. */
  heartbeatMs?: number;
  /** CI: include K8s Events inline. Off by default. */
  showEvents?: boolean;
  /** CI: every N idle heartbeats, expand into a snapshot of unready + blocked resources. 0 disables. */
  snapshotEveryHeartbeats?: number;
  /** CI: strip ANSI colour escapes from the rendered output. */
  noColor?: boolean;
}

/**
 * Drive either renderer against the supplied watcher. Resolves when the
 * watcher's event stream ends.
 */
export async function runRenderer(watcher: XrWatcher, opts: RunRendererOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const mode = opts.mode ?? selectRenderer(out);
  if (mode === 'tty') {
    const ttyOpts: Parameters<typeof renderTTY>[1] = {
      ref: opts.ref,
      out: out as NodeJS.WriteStream,
    };
    if (opts.eventTailSize !== undefined) ttyOpts.eventTailSize = opts.eventTailSize;
    return renderTTY(watcher, ttyOpts);
  }
  const ciOpts: Parameters<typeof renderCI>[1] = { ref: opts.ref, out };
  if (opts.heartbeatMs !== undefined) ciOpts.heartbeatMs = opts.heartbeatMs;
  if (opts.showEvents !== undefined) ciOpts.showEvents = opts.showEvents;
  if (opts.snapshotEveryHeartbeats !== undefined)
    ciOpts.snapshotEveryHeartbeats = opts.snapshotEveryHeartbeats;
  if (opts.noColor !== undefined) ciOpts.noColor = opts.noColor;
  return renderCI(watcher, ciOpts);
}
