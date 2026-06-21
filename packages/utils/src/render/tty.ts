import chalk from 'chalk';
import { createLogUpdate } from 'log-update';
import { buildTree, type ResourceTree, type TreeNode } from '../watcher/tree.js';
import type { KubernetesEvent, XrEvent, XrRef, XrSnapshot } from '../watcher/types.js';
import type { XrWatcher } from '../watcher/xr-watcher.js';
import { formatHeader, formatProgress, statusGlyph } from './format.js';

export interface TtyRendererOptions {
  ref: XrRef;
  /** Destination stream. Defaults to `process.stdout`. */
  out?: NodeJS.WriteStream;
  /** Maximum number of recent Kubernetes events shown in the tail. Defaults to 5. */
  eventTailSize?: number;
  /** Allows callers (and tests) to provide a custom `log-update` instance. */
  logger?: { (frame: string): void; clear: () => void; done: () => void };
}

/**
 * Live full-screen renderer using `log-update` to repaint a single frame.
 * Resolves when the watcher ends.
 */
export async function renderTTY(watcher: XrWatcher, opts: TtyRendererOptions): Promise<void> {
  const out = opts.out ?? process.stdout;
  const logger = opts.logger ?? createLogUpdate(out);
  const tailSize = opts.eventTailSize ?? 5;
  const events: KubernetesEvent[] = [];
  let snapshot: XrSnapshot | undefined;
  let lastError: Error | undefined;

  const repaint = () => {
    logger(renderFrame(opts.ref, snapshot, events, lastError, out.rows, out.columns));
  };
  repaint();

  for await (const ev of watcher as AsyncIterable<XrEvent>) {
    if (ev.type === 'snapshot') {
      snapshot = ev.snapshot;
      repaint();
    } else if (ev.type === 'k8s-event') {
      events.push(ev.event);
      if (events.length > tailSize) events.splice(0, events.length - tailSize);
      repaint();
    } else if (ev.type === 'error') {
      lastError = ev.error;
      repaint();
    } else if (ev.type === 'ready') {
      snapshot = ev.snapshot;
      repaint();
    } else if (ev.type === 'end') {
      logger.done();
      return;
    }
  }
  logger.done();
}

function renderFrame(
  ref: XrRef,
  snapshot: XrSnapshot | undefined,
  events: KubernetesEvent[],
  err: Error | undefined,
  rows: number | undefined,
  columns: number | undefined,
): string {
  const lines: string[] = [];
  if (snapshot) {
    lines.push(formatHeader(snapshot, ref));
    const tree = buildTree(snapshot);
    if (tree.stats.total > 0) {
      lines.push(
        `  ${formatProgress(tree.stats.ready, tree.stats.total, tree.stats.blocked)}  ${chalk.dim(`(source: ${tree.source})`)}`,
      );
    }
    if (snapshot.readyMessage) {
      lines.push(chalk.dim(`  ${snapshot.readyMessage}`));
    }
    if (tree.roots.length > 0) {
      lines.push('');
      lines.push(chalk.bold('Resources'));
      renderTreeLines(tree, lines);
    }
  } else {
    lines.push(chalk.dim(`waiting for first observation of ${ref.kind}/${ref.name}…`));
  }

  const errLines: string[] = [];
  if (err) {
    errLines.push('');
    errLines.push(chalk.red(`error: ${err.message}`));
  }

  const eventLines: string[] = [];
  if (events.length > 0) {
    eventLines.push('');
    eventLines.push(chalk.bold('Recent events'));
    for (const e of events) eventLines.push(`  ${formatEventLine(e)}`);
  }

  // When the terminal height is known, ensure the snapshot header + tree are
  // always visible by trimming the event tail (oldest first) to whatever rows
  // remain after reserving space for the snapshot block and error footer.
  if (rows && rows > 0 && eventLines.length > 0) {
    const reserved = lines.length + errLines.length;
    const available = rows - reserved;
    if (available <= 2) {
      // No room for events at all — drop them entirely.
      eventLines.length = 0;
    } else if (eventLines.length > available) {
      // Keep the heading + blank line, drop the oldest events to fit.
      const keep = available - 2;
      const kept = eventLines.slice(eventLines.length - keep);
      eventLines.length = 0;
      eventLines.push('', chalk.bold('Recent events'), ...kept);
    }
  }

  const all = [...lines, ...eventLines, ...errLines];
  if (columns && columns > 0) {
    for (let i = 0; i < all.length; i++) {
      const line = all[i] as string;
      if (visibleWidth(line) > columns) all[i] = truncateAnsi(line, columns);
    }
  }
  return all.join('\n');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require ESC (0x1B).
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Truncate a string with embedded ANSI escapes to `maxVisible` visible chars,
 * appending an ellipsis and a reset code. */
function truncateAnsi(s: string, maxVisible: number): string {
  if (maxVisible <= 1) return '\u2026';
  let visible = 0;
  let out = '';
  const limit = maxVisible - 1;
  let i = 0;
  while (i < s.length && visible < limit) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m && m.index === i) {
      out += m[0];
      i = m.index + m[0].length;
      continue;
    }
    out += s[i];
    visible++;
    i++;
  }
  return `${out}\u2026\u001b[0m`;
}

function renderTreeLines(tree: ResourceTree, out: string[]): void {
  for (const root of tree.roots) renderNode(root, '', true, out);
}

function renderNode(node: TreeNode, prefix: string, isLast: boolean, out: string[]): void {
  const branch = prefix === '' ? '' : isLast ? '└─ ' : '├─ ';
  const state = node.blocked ? 'blocked' : node.ready ? 'ready' : 'pending';
  const meta = node.kind ? chalk.dim(` (${node.kind})`) : '';
  const nameDetail = node.name
    ? chalk.dim(node.namespace ? ` ${node.namespace}/${node.name}` : ` ${node.name}`)
    : '';
  const waiting =
    node.waitingFor && node.waitingFor.length > 0
      ? chalk.dim(`  waiting for ${node.waitingFor.join(', ')}`)
      : '';
  out.push(`${prefix}${branch}${statusGlyph(state)} ${node.label}${meta}${nameDetail}${waiting}`);
  const childPrefix = prefix + (prefix === '' ? '  ' : isLast ? '   ' : '│  ');
  for (let i = 0; i < node.children.length; i++) {
    renderNode(node.children[i] as TreeNode, childPrefix, i === node.children.length - 1, out);
  }
}

function formatEventLine(ev: KubernetesEvent): string {
  const color = ev.type === 'Warning' ? chalk.yellow : chalk.dim;
  const t = ev.lastTimestamp ? new Date(ev.lastTimestamp).toISOString().slice(11, 19) : '';
  const target = ev.involvedKind ? `${ev.involvedKind}/${ev.involvedName ?? '?'} ` : '';
  return color(`${t} ${target}${ev.reason}: ${ev.message}`).trim();
}
