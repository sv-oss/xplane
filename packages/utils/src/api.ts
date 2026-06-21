import type { KubeConfig } from '@kubernetes/client-node';
import { resolveResource } from './cli/discovery.js';
import { listXrCollection } from './client/lists.js';
import { type RunRendererOptions, runRenderer } from './render/index.js';
import { type AwaitReadyOptions, awaitReady } from './watcher/await-ready.js';
import { parseTarget } from './watcher/target.js';
import type { XrRef, XrSnapshot } from './watcher/types.js';
import { createXrWatcher } from './watcher/xr-watcher.js';

/**
 * Parse a kubectl-style target string, resolve its CRD against the cluster,
 * and return a fully-populated `XrRef`. Throws if the resolved kind is
 * namespaced and no namespace was supplied.
 */
export async function resolveTarget(
  kc: KubeConfig,
  target: string,
  namespace?: string,
): Promise<XrRef> {
  const parsed = parseTarget(target);
  const resolved = await resolveResource(kc, {
    resource: parsed.resource,
    group: parsed.group,
    version: parsed.version,
  });
  const ref: XrRef = {
    group: resolved.group,
    version: resolved.version,
    plural: resolved.plural,
    kind: resolved.kind,
    namespaced: resolved.namespaced,
    name: parsed.name,
    namespace,
  };
  if (ref.namespaced && !ref.namespace) {
    throw new Error(`${ref.kind} is namespaced — pass a namespace`);
  }
  return ref;
}

export interface GetStatusOptions {
  /** Include the framework-managed `status.xplane` subtree. Defaults to false. */
  includeXplane?: boolean;
  /** Include `status.conditions`. Defaults to false. */
  includeConditions?: boolean;
}

/**
 * Fetch a single XR and return its filtered `.status` object. Throws when the
 * XR cannot be found.
 */
export async function getStatus(
  kc: KubeConfig,
  ref: XrRef,
  opts: GetStatusOptions = {},
): Promise<Record<string, unknown>> {
  const result = await listXrCollection(kc, ref);
  const item = result.items[0] as Record<string, unknown> | undefined;
  if (!item) {
    const t = `${ref.kind}/${ref.name}${ref.namespace ? ` -n ${ref.namespace}` : ''}`;
    throw new Error(`${t} not found`);
  }
  const status = (item.status ?? {}) as Record<string, unknown>;
  const excluded = new Set<string>();
  if (!opts.includeXplane) excluded.add('xplane');
  if (!opts.includeConditions) excluded.add('conditions');
  if (excluded.size === 0) return status;
  return Object.fromEntries(Object.entries(status).filter(([k]) => !excluded.has(k)));
}

export interface WatchUntilReadyOptions {
  kubeConfig: KubeConfig;
  ref: XrRef;
  /** Aborts the underlying watcher and renderer. */
  signal?: AbortSignal;
  /** Maximum time to wait for Ready before rejecting. */
  timeoutMs?: number;
  /** Disable subscribing to Kubernetes Events for the XR. */
  disableEvents?: boolean;
  /**
   * Renderer configuration. Pass `false` to skip rendering entirely (silent
   * mode). When omitted, the default renderer runs against `process.stdout`.
   */
  renderer?: Omit<RunRendererOptions, 'ref'> | false;
}

/**
 * One-shot watch-and-wait: builds an `XrWatcher`, optionally drives a renderer
 * against it, awaits the first Ready snapshot (with optional timeout), and
 * guarantees cleanup of the watcher + renderer in both success and failure
 * paths.
 *
 * Returns the snapshot at the moment of readiness.
 */
export async function watchUntilReady(opts: WatchUntilReadyOptions): Promise<XrSnapshot> {
  const watcher = createXrWatcher({
    kubeConfig: opts.kubeConfig,
    ref: opts.ref,
    signal: opts.signal,
    disableEvents: opts.disableEvents,
  });
  const renderPromise: Promise<void> =
    opts.renderer === false
      ? Promise.resolve()
      : runRenderer(watcher, { ref: opts.ref, ...opts.renderer });
  const waitOpts: AwaitReadyOptions = {};
  if (opts.timeoutMs !== undefined) waitOpts.timeoutMs = opts.timeoutMs;
  try {
    const snapshot = await awaitReady(watcher, waitOpts);
    watcher.stop();
    await renderPromise;
    return snapshot;
  } catch (err) {
    watcher.stop();
    await renderPromise.catch(() => undefined);
    throw err;
  }
}
