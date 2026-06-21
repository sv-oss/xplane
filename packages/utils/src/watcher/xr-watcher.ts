import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { listXrCollection, listXrEvents } from '../client/lists.js';
import { listAndWatch } from '../client/watch.js';
import { AsyncQueue } from './queue.js';
import { buildSnapshot } from './readiness.js';
import type { KubernetesEvent, XrEvent, XrRef, XrSnapshot } from './types.js';

export interface CreateXrWatcherOptions {
  kubeConfig: KubeConfig;
  ref: XrRef;
  /** Disable subscribing to Kubernetes Events for the XR. Defaults to `false`. */
  disableEvents?: boolean;
  /** Aborts both the XR and Events watches and closes the iterable. */
  signal?: AbortSignal;
}

export interface XrWatcher extends AsyncIterable<XrEvent> {
  /** Resolves with the first ready snapshot. Rejects on error or end-before-ready. */
  readonly ready: Promise<XrSnapshot>;
  /** Resolves when the watcher's background tasks have all settled. */
  readonly done: Promise<void>;
  /** Aborts the watcher and closes the iterable. Idempotent. */
  stop(): void;
}

/**
 * Subscribe to live updates of a single XR. Emits a `snapshot` on every observed
 * change, a one-shot `ready` when the XR's `Ready` condition first becomes True,
 * and (unless disabled) `k8s-event` items for Kubernetes Events targeting the XR.
 *
 * The watcher uses list-then-watch with auto-reconnect — no polling.
 */
export function createXrWatcher(opts: CreateXrWatcherOptions): XrWatcher {
  const queue = new AsyncQueue<XrEvent>();
  const controller = new AbortController();
  const userSignal = opts.signal;
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let readyEmitted = false;
  let uid: string | undefined;
  let eventsStarted = false;
  let eventsTask: Promise<void> = Promise.resolve();
  const seenEventUids = new Set<string>();

  let resolveReady!: (snap: XrSnapshot) => void;
  let rejectReady!: (err: Error) => void;
  let readySettled = false;
  const ready = new Promise<XrSnapshot>((res, rej) => {
    resolveReady = (s) => {
      if (readySettled) return;
      readySettled = true;
      res(s);
    };
    rejectReady = (e) => {
      if (readySettled) return;
      readySettled = true;
      rej(e);
    };
  });
  // Avoid unhandled rejection if nobody awaits `ready`.
  ready.catch(() => undefined);

  const handleXrEvent = (phase: string, obj: KubernetesObject) => {
    if (phase === 'DELETED') {
      const err = new Error(`XR ${opts.ref.kind}/${opts.ref.name} was deleted`);
      queue.push({ type: 'error', error: err });
      rejectReady(err);
      controller.abort();
      return;
    }
    if (phase === 'BOOKMARK' || phase === 'ERROR') return;
    const snapshot = buildSnapshot(obj);
    queue.push({ type: 'snapshot', snapshot });
    if (snapshot.syncError) {
      const err = new Error(
        `XR ${opts.ref.kind}/${opts.ref.name} reconcile failed: ${snapshot.syncError.message || snapshot.syncError.reason}`,
      );
      queue.push({ type: 'error', error: err });
      rejectReady(err);
      controller.abort();
      return;
    }
    if (!readyEmitted && snapshot.ready) {
      readyEmitted = true;
      queue.push({ type: 'ready', snapshot });
      resolveReady(snapshot);
    }
    const newUid = obj.metadata?.uid as string | undefined;
    if (newUid && !uid) {
      uid = newUid;
      if (!opts.disableEvents && opts.ref.namespaced && opts.ref.namespace) {
        eventsStarted = true;
        eventsTask = startEventsWatch(opts, uid, controller.signal, queue, seenEventUids);
      }
    }
  };

  const xrPath = buildResourcePath(opts.ref);
  let firstListSeenItem = false;
  const xrTask = listAndWatch(opts.kubeConfig, {
    path: xrPath,
    fieldSelector: `metadata.name=${opts.ref.name}`,
    signal: controller.signal,
    list: async () => {
      const result = await listXrCollection(opts.kubeConfig, opts.ref);
      if (!firstListSeenItem) {
        if (result.items.length > 0) {
          firstListSeenItem = true;
        } else {
          const where = opts.ref.namespace ? ` in namespace ${opts.ref.namespace}` : '';
          const err = new Error(`XR ${opts.ref.kind}/${opts.ref.name} not found${where}`);
          queue.push({ type: 'error', error: err });
          rejectReady(err);
          controller.abort();
        }
      }
      return result;
    },
    onEvent: handleXrEvent,
    onError: (err) => {
      queue.push({ type: 'error', error: err });
      rejectReady(err);
    },
  });

  const done = (async () => {
    try {
      await xrTask;
    } finally {
      if (eventsStarted) {
        try {
          await eventsTask;
        } catch {
          /* already surfaced via onError */
        }
      }
      rejectReady(new Error('Watcher ended before XR became Ready'));
      queue.push({ type: 'end' });
      queue.close();
    }
  })();

  return {
    ready,
    done,
    stop: () => controller.abort(),
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  };
}

function buildResourcePath(ref: XrRef): string {
  const base = ref.group ? `/apis/${ref.group}/${ref.version}` : `/api/${ref.version}`;
  if (ref.namespaced) {
    if (!ref.namespace) {
      throw new Error(`Namespace is required for namespaced resource ${ref.kind}/${ref.name}`);
    }
    return `${base}/namespaces/${ref.namespace}/${ref.plural}`;
  }
  return `${base}/${ref.plural}`;
}

async function startEventsWatch(
  opts: CreateXrWatcherOptions,
  uid: string,
  signal: AbortSignal,
  queue: AsyncQueue<XrEvent>,
  seen: Set<string>,
): Promise<void> {
  if (!opts.ref.namespace) return;
  const namespace = opts.ref.namespace;
  const path = `/api/v1/namespaces/${namespace}/events`;
  const fieldSelector = `involvedObject.uid=${uid}`;
  await listAndWatch(opts.kubeConfig, {
    path,
    fieldSelector,
    signal,
    list: () => listXrEvents(opts.kubeConfig, namespace, fieldSelector),
    onEvent: (phase, obj) => {
      if (phase !== 'ADDED' && phase !== 'MODIFIED') return;
      const eventUid = obj.metadata?.uid as string | undefined;
      if (eventUid && seen.has(eventUid)) return;
      if (eventUid) seen.add(eventUid);
      const event = toKubernetesEvent(obj);
      if (event) queue.push({ type: 'k8s-event', event });
    },
    onError: (err) => queue.push({ type: 'error', error: err }),
  });
}

function toKubernetesEvent(obj: KubernetesObject): KubernetesEvent | undefined {
  const raw = obj as KubernetesObject & {
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
    eventTime?: string;
    involvedObject?: { kind?: string; name?: string };
  };
  if (!raw.message && !raw.reason) return undefined;
  const event: KubernetesEvent = {
    type: raw.type ?? 'Normal',
    reason: raw.reason ?? '',
    message: raw.message ?? '',
    count: raw.count ?? 1,
  };
  const first = raw.firstTimestamp ?? raw.eventTime;
  const last = raw.lastTimestamp ?? raw.eventTime ?? first;
  if (first) event.firstTimestamp = first;
  if (last) event.lastTimestamp = last;
  if (raw.involvedObject?.kind) event.involvedKind = raw.involvedObject.kind;
  if (raw.involvedObject?.name) event.involvedName = raw.involvedObject.name;
  return event;
}
