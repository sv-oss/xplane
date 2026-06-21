import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { Watch } from '@kubernetes/client-node';

/** Watch event phase as published by the Kubernetes watch protocol. */
export type WatchPhase = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

/** Result of an initial list call. */
export interface ListResult<T extends KubernetesObject = KubernetesObject> {
  resourceVersion: string;
  items: T[];
}

export interface ListWatchOptions {
  /** Watch URL path, e.g. `/apis/group/v1/namespaces/ns/plural`. */
  path: string;
  /** Optional field selector applied to the watch stream. */
  fieldSelector?: string;
  /** Optional label selector applied to the watch stream. */
  labelSelector?: string;
  /** Aborts both the initial list and any subsequent watch streams. */
  signal: AbortSignal;
  /** Caller-provided initial list. Use a typed client (`CoreV1Api`, `CustomObjectsApi`, …). */
  list: () => Promise<ListResult>;
  /** Invoked for each observed object (after the initial list and on each watch event). */
  onEvent: (phase: WatchPhase, obj: KubernetesObject) => void;
  /** Invoked when a stream ends in error and a reconnect is about to be attempted. */
  onError?: (err: Error) => void;
}

interface ReconnectableState {
  resourceVersion: string;
}

/**
 * Run a robust list-then-watch loop. The initial list is supplied by the caller
 * (so it can use a typed Kubernetes client); the watch stream uses the raw
 * `Watch` class because it is the only API surface that supports a
 * `fieldSelector` for a single named object.
 *
 * Behaviour:
 *   1. Call `opts.list()` and emit each item as `ADDED`.
 *   2. Start a `Watch` stream from the returned `resourceVersion`. Each event is forwarded.
 *   3. When the stream ends with an error or the server closes it, sleep briefly and reconnect.
 *   4. The loop exits cleanly when the supplied `AbortSignal` fires.
 */
export async function listAndWatch(kc: KubeConfig, opts: ListWatchOptions): Promise<void> {
  const state: ReconnectableState = { resourceVersion: '' };
  const watcher = new Watch(kc);

  while (!opts.signal.aborted) {
    try {
      const list = await opts.list();
      state.resourceVersion = list.resourceVersion;
      for (const item of list.items) opts.onEvent('ADDED', item);

      await runWatchOnce(watcher, opts, state);
    } catch (err) {
      if (opts.signal.aborted) return;
      const e = err instanceof Error ? err : new Error(String(err));
      opts.onError?.(e);
      await sleep(1000, opts.signal);
    }
  }
}

function runWatchOnce(
  watcher: Watch,
  opts: ListWatchOptions,
  state: ReconnectableState,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const queryParams: Record<string, string | boolean> = { watch: true };
    if (opts.fieldSelector) queryParams.fieldSelector = opts.fieldSelector;
    if (opts.labelSelector) queryParams.labelSelector = opts.labelSelector;
    if (state.resourceVersion) queryParams.resourceVersion = state.resourceVersion;
    queryParams.allowWatchBookmarks = true;

    let controllerRef: AbortController | undefined;
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = () => {
      controllerRef?.abort();
      resolveOnce();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    watcher
      .watch(
        opts.path,
        queryParams,
        (phase, apiObj) => {
          const obj = apiObj as KubernetesObject;
          const objRv = (obj.metadata?.resourceVersion as string | undefined) ?? '';
          if (objRv) state.resourceVersion = objRv;
          opts.onEvent(phase as WatchPhase, obj);
        },
        (err) => {
          if (err) rejectOnce(err);
          else resolveOnce();
        },
      )
      .then((controller) => {
        controllerRef = controller;
        if (opts.signal.aborted) {
          controller.abort();
          resolveOnce();
        }
      })
      .catch((err) => rejectOnce(err));
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
