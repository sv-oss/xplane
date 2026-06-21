import chalk from 'chalk';
import type {
  KubernetesEvent,
  XplaneStatus,
  XrEvent,
  XrRef,
  XrSnapshot,
} from '../watcher/types.js';
import type { XrWatcher } from '../watcher/xr-watcher.js';
import { formatEvent } from './format.js';

export interface CiRendererOptions {
  ref: XrRef;
  /** Destination stream. Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Heartbeat interval (ms). When no changes are observed within this window, emit a "no change" line so CI can see the job is alive. Defaults to 30000. Set to 0 to disable. */
  heartbeatMs?: number;
  /** When true, K8s Events are echoed inline. Defaults to false in CI (too noisy). */
  showEvents?: boolean;
  /** Every N consecutive idle heartbeats, expand the heartbeat line into a snapshot of unready + blocked resources. Defaults to 10. Set to 0 to disable. */
  snapshotEveryHeartbeats?: number;
}

/**
 * Append-only CI renderer.
 *
 * 1. Print a one-line "watching …" header on startup.
 * 2. On the first snapshot, print a full snapshot block.
 * 3. On every subsequent snapshot, print only the delta.
 * 4. If nothing is printed within `heartbeatMs`, emit a single liveness line.
 */
export async function renderCI(watcher: XrWatcher, opts: CiRendererOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const showEvents = opts.showEvents ?? false;
  const snapshotEvery = opts.snapshotEveryHeartbeats ?? 10;
  const write = (line: string) => out.write(`${line}\n`);
  const stamp = () => new Date().toISOString().slice(11, 19);
  let lastWriteAt = Date.now();
  /** Warning (and worse) K8s events buffered since the last flush — always surfaced even when `showEvents` is off. */
  const pendingWarnings: KubernetesEvent[] = [];
  const flushPendingWarnings = () => {
    if (pendingWarnings.length === 0) return;
    for (const e of pendingWarnings) write(formatEvent(e));
    pendingWarnings.length = 0;
    lastWriteAt = Date.now();
  };
  const emit = (line: string) => {
    flushPendingWarnings();
    write(line);
    lastWriteAt = Date.now();
  };

  let prev: SnapshotSummary | undefined;
  let idleHeartbeats = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      // Surface any buffered warnings first, even if the snapshot itself hasn't changed.
      const hadWarnings = pendingWarnings.length > 0;
      flushPendingWarnings();
      if (!prev) return;
      if (!hadWarnings && Date.now() - lastWriteAt < heartbeatMs) return;
      idleHeartbeats += 1;
      const expand = snapshotEvery > 0 && idleHeartbeats % snapshotEvery === 0;
      const ts = stamp();
      const counts = formatCounts(prev.readyCount, prev.total, prev.blockedCount);
      const headline = `${chalk.dim(ts)} ${chalk.dim('→')} ${counts} ${chalk.dim('(no change)')}`;
      if (!expand) {
        emit(headline);
        return;
      }
      emit([headline, ...renderPendingBlock(prev)].join('\n'));
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  emit(
    `${chalk.dim(stamp())} ${chalk.bold(`watching ${opts.ref.kind}/${opts.ref.name}${opts.ref.namespace ? ` -n ${opts.ref.namespace}` : ''}`)}`,
  );

  try {
    for await (const ev of watcher as AsyncIterable<XrEvent>) {
      if (ev.type === 'snapshot') {
        const next = summarise(ev.snapshot);
        if (!prev) {
          emit(renderFullSnapshot(opts.ref, ev.snapshot, next, stamp()));
          idleHeartbeats = 0;
        } else {
          const delta = renderDelta(prev, next, stamp());
          if (delta) {
            emit(delta);
            idleHeartbeats = 0;
          }
        }
        prev = next;
      } else if (ev.type === 'k8s-event') {
        if (showEvents) {
          emit(formatEvent(ev.event));
        } else if (ev.event.type !== 'Normal') {
          // Warnings (and any future non-Normal severities) are always surfaced —
          // buffered here and flushed on the next emit / heartbeat.
          pendingWarnings.push(ev.event);
        }
      } else if (ev.type === 'ready') {
        emit(
          `${chalk.dim(stamp())} ${chalk.green('✔')} ${opts.ref.kind}/${opts.ref.name} ${chalk.green('is Ready')}`,
        );
      } else if (ev.type === 'error') {
        emit(`${chalk.dim(stamp())} ${chalk.red('error:')} ${ev.error.message}`);
      } else if (ev.type === 'end') {
        flushPendingWarnings();
        return;
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

interface SnapshotSummary {
  reason: string | undefined;
  readyCount: number;
  blockedCount: number;
  total: number;
  ready: Set<string>;
  unready: string[];
  blocked: Map<string, string[]>;
}

function summarise(snapshot: XrSnapshot): SnapshotSummary {
  const x: XplaneStatus | undefined = snapshot.xplane;
  const ready = new Set<string>();
  const unready: string[] = [];
  const blocked = new Map<string, string[]>();
  if (x) {
    for (const r of x.emittedResources) {
      if (r.ready) ready.add(r.nodePath);
      else unready.push(r.nodePath);
    }
    for (const b of x.blockedResources) blocked.set(b.nodePath, b.waitingFor ?? []);
  }
  return {
    reason: snapshot.readyReason ?? (snapshot.ready ? 'Available' : undefined),
    readyCount: ready.size || (snapshot.ready ? 1 : 0),
    blockedCount: blocked.size,
    total: x?.emittedResources.length ?? snapshot.resourceRefs.length,
    ready,
    unready,
    blocked,
  };
}

function renderPendingBlock(s: SnapshotSummary): string[] {
  const lines: string[] = [];
  if (s.unready.length > 0) {
    lines.push(chalk.dim('   unready:'));
    for (const path of s.unready) lines.push(`   ${chalk.dim('⏳')} ${path}`);
  }
  if (s.blocked.size > 0) {
    lines.push(chalk.dim('   blocked:'));
    for (const [path, waiting] of s.blocked) {
      lines.push(`   ${chalk.yellow('-')} ${path}${formatWaiting(waiting)}`);
    }
  }
  return lines;
}

function renderFullSnapshot(
  ref: XrRef,
  snapshot: XrSnapshot,
  s: SnapshotSummary,
  ts: string,
): string {
  const lines: string[] = [];
  const reason = s.reason ?? 'Pending';
  const target = `${ref.kind}/${ref.name}${ref.namespace ? ` (${ref.namespace})` : ''}`;
  const counts = formatCounts(s.readyCount, s.total, s.blockedCount);
  lines.push(
    `${chalk.dim(ts)} ${chalk.bold(target)} ${chalk.dim('·')} ${reason} ${chalk.dim('·')} ${counts}`,
  );
  if (snapshot.updatesThrottled) {
    lines.push(`   ${chalk.yellow('⚠ Updates Throttled')}`);
  }
  if (s.blocked.size > 0) {
    lines.push(chalk.dim('   blocked:'));
    for (const [path, waiting] of s.blocked) {
      lines.push(`   ${chalk.yellow('-')} ${path}${formatWaiting(waiting)}`);
    }
  }
  return lines.join('\n');
}

function renderDelta(prev: SnapshotSummary, next: SnapshotSummary, ts: string): string | undefined {
  const becameReady: string[] = [];
  const becameBlocked: string[] = [];
  const waitingChanged: string[] = [];

  for (const path of next.ready) if (!prev.ready.has(path)) becameReady.push(path);
  for (const [path, waiting] of next.blocked) {
    if (!prev.blocked.has(path)) {
      becameBlocked.push(path);
    } else {
      const a = (prev.blocked.get(path) ?? []).join('|');
      const b = waiting.join('|');
      if (a !== b) waitingChanged.push(path);
    }
  }
  const reasonChanged = next.reason !== prev.reason;
  const totalsChanged =
    next.readyCount !== prev.readyCount ||
    next.blockedCount !== prev.blockedCount ||
    next.total !== prev.total;

  if (
    becameReady.length === 0 &&
    becameBlocked.length === 0 &&
    waitingChanged.length === 0 &&
    !reasonChanged &&
    !totalsChanged
  ) {
    return undefined;
  }

  const lines: string[] = [];
  const tsd = chalk.dim(ts);
  for (const path of becameReady) lines.push(`${tsd} ${chalk.green('+')} ${path}`);
  for (const path of becameBlocked) {
    const waiting = next.blocked.get(path) ?? [];
    lines.push(`${tsd} ${chalk.yellow('-')} ${path}${formatWaiting(waiting)}`);
  }
  for (const path of waitingChanged) {
    const waiting = next.blocked.get(path) ?? [];
    lines.push(`${tsd} ${chalk.yellow('~')} ${path}${formatWaiting(waiting)}`);
  }
  if (reasonChanged && next.reason) {
    lines.push(
      `${tsd} ${chalk.yellow('~')} reason: ${chalk.dim(prev.reason ?? '?')} → ${next.reason}`,
    );
  }
  lines.push(
    `${tsd} ${chalk.dim('→')} ${formatCounts(next.readyCount, next.total, next.blockedCount)}`,
  );
  return lines.join('\n');
}

function formatCounts(ready: number, total: number, blocked: number): string {
  const unready = Math.max(0, total - ready);
  const grand = total + blocked;
  const pct = grand > 0 ? Math.round((ready / grand) * 100) : 0;
  const readyText = `✅ ${ready} ready`;
  const readyPart = total > 0 && ready === total ? chalk.green(readyText) : readyText;
  const unreadyPart = `⏳ ${unready} unready`;
  const blockedPart = `🚧 ${blocked} blocked`;
  const pctPart = `📈 ${pct}%`;
  const dot = '·';
  return `${readyPart} ${dot} ${unreadyPart} ${dot} ${blockedPart} ${dot} ${pctPart}`;
}

function formatWaiting(waiting: string[]): string {
  if (waiting.length === 0) return '';
  return chalk.dim(`  waiting ${waiting.join(', ')}`);
}
