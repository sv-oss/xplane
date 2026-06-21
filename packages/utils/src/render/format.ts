import chalk from 'chalk';
import type { KubernetesEvent, XrSnapshot } from '../watcher/types.js';

/** Single-character glyph for the status of a tree node. */
export function statusGlyph(state: 'ready' | 'pending' | 'blocked'): string {
  switch (state) {
    case 'ready':
      return chalk.green('✔');
    case 'blocked':
      return chalk.red('✖');
    case 'pending':
      return chalk.yellow('⏳');
  }
}

/** Compact header line summarising the XR. */
export function formatHeader(
  snapshot: XrSnapshot,
  ref: { kind: string; name: string; namespace?: string },
): string {
  const obj = snapshot.object;
  const fqdn = ref.namespace
    ? `${ref.kind}/${ref.name} (${ref.namespace})`
    : `${ref.kind}/${ref.name}`;
  const readyState = snapshot.ready
    ? chalk.green('Ready')
    : chalk.yellow(snapshot.readyReason ?? 'NotReady');
  const ts = obj.metadata?.creationTimestamp as unknown as string | Date | undefined;
  const age = ts ? formatAge(new Date(ts)) : '?';
  const throttled = snapshot.updatesThrottled ? `  ${chalk.yellow('⚠ Updates Throttled')}` : '';
  return `${chalk.bold(fqdn)}  age=${age}  ${readyState}${throttled}`;
}

/** Inline progress representation, e.g. `5/12 ready · 3 blocked`. */
export function formatProgress(ready: number, total: number, blocked: number): string {
  const parts: string[] = [`${ready}/${total} ready`];
  if (blocked > 0) parts.push(chalk.red(`${blocked} blocked`));
  return parts.join(chalk.dim(' · '));
}

/** Format a Kubernetes Event as a single line. */
export function formatEvent(ev: KubernetesEvent): string {
  const color = ev.type === 'Warning' ? chalk.yellow : chalk.dim;
  const target = ev.involvedKind && ev.involvedName ? `${ev.involvedKind}/${ev.involvedName} ` : '';
  return color(`${ev.lastTimestamp ?? ''} ${target}${ev.reason}: ${ev.message}`.trim());
}

function formatAge(from: Date): string {
  const ms = Date.now() - from.getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
