import type { KubeConfig } from '@kubernetes/client-node';
import { type LoadKubeConfigOptions, loadKubeConfig } from '../client/kubeconfig.js';
import { type RendererMode, runRenderer } from '../render/index.js';
import { awaitReady } from '../watcher/await-ready.js';
import { parseTarget } from '../watcher/target.js';
import type { XrRef } from '../watcher/types.js';
import { createXrWatcher, type XrWatcher } from '../watcher/xr-watcher.js';
import { resolveResource } from './discovery.js';
import { parseDuration } from './duration.js';

export interface WatchCommandArgs {
  target: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  timeout?: string;
  mode?: string;
  disableEvents?: boolean;
  /** CI: heartbeat interval (e.g. "30s"). 0 disables. */
  heartbeat?: string;
  /** CI: include K8s Events inline (off by default). */
  showEvents?: boolean;
  /** CI: every N idle heartbeats, expand into a snapshot of unready + blocked resources. 0 disables. */
  snapshotEveryHeartbeats?: number;
}

export interface WatchCommandDeps {
  /** Override KubeConfig loader (for tests). */
  loadKubeConfig?: (opts: LoadKubeConfigOptions) => KubeConfig;
  /** Override discovery (for tests). */
  resolveResource?: typeof resolveResource;
  /** Override watcher factory (for tests). */
  createXrWatcher?: typeof createXrWatcher;
  /** Override renderer (for tests). */
  runRenderer?: typeof runRenderer;
  /** Override awaitReady (for tests). */
  awaitReady?: typeof awaitReady;
  /** Destination stream for the renderer. */
  out?: NodeJS.WriteStream;
  /** Signal that aborts both the watcher and renderer. */
  signal?: AbortSignal;
}

export type WatchResult = { code: 0 } | { code: 1; error?: string };

/**
 * Headless implementation of the `xplane-utils watch` subcommand.
 * Returns the exit code instead of calling `process.exit` so it is unit-testable.
 */
export async function runWatchCommand(
  args: WatchCommandArgs,
  deps: WatchCommandDeps = {},
): Promise<WatchResult> {
  const load = deps.loadKubeConfig ?? loadKubeConfig;
  const resolve = deps.resolveResource ?? resolveResource;
  const factory = deps.createXrWatcher ?? createXrWatcher;
  const render = deps.runRenderer ?? runRenderer;
  const wait = deps.awaitReady ?? awaitReady;

  const kcOpts: LoadKubeConfigOptions = {};
  if (args.kubeconfig !== undefined) kcOpts.kubeconfig = args.kubeconfig;
  if (args.context !== undefined) kcOpts.context = args.context;
  const kc = load(kcOpts);

  const parsed = parseTarget(args.target);
  const resolved = await resolve(kc, {
    resource: parsed.resource,
    ...(parsed.group !== undefined ? { group: parsed.group } : {}),
    ...(parsed.version !== undefined ? { version: parsed.version } : {}),
  });
  const ref: XrRef = {
    group: resolved.group,
    version: resolved.version,
    plural: resolved.plural,
    kind: resolved.kind,
    namespaced: resolved.namespaced,
    name: parsed.name,
    ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
  };
  if (ref.namespaced && !ref.namespace) {
    return { code: 1, error: `${ref.kind} is namespaced — pass --namespace/-n` };
  }

  const watcher: XrWatcher = factory({
    kubeConfig: kc,
    ref,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(args.disableEvents ? { disableEvents: true } : {}),
  });

  const mode: RendererMode | undefined =
    args.mode === 'tty' || args.mode === 'ci' ? args.mode : undefined;
  const renderOpts: Parameters<typeof runRenderer>[1] = { ref };
  if (mode) renderOpts.mode = mode;
  if (deps.out) renderOpts.out = deps.out;
  const heartbeatMs = parseDuration(args.heartbeat);
  if (heartbeatMs !== undefined) renderOpts.heartbeatMs = heartbeatMs;
  if (args.showEvents !== undefined) renderOpts.showEvents = args.showEvents;
  if (args.snapshotEveryHeartbeats !== undefined)
    renderOpts.snapshotEveryHeartbeats = args.snapshotEveryHeartbeats;
  const renderPromise = render(watcher, renderOpts);

  const timeoutMs = parseDuration(args.timeout);
  try {
    await wait(watcher, timeoutMs !== undefined ? { timeoutMs } : {});
    watcher.stop();
    await renderPromise;
    return { code: 0 };
  } catch (_err) {
    watcher.stop();
    await renderPromise.catch(() => undefined);
    // The renderer already surfaced the error inline — omit it here to avoid duplication.
    return { code: 1 };
  }
}
