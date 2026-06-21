import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedCall {
  path: string;
  fieldSelector?: string;
  signal: AbortSignal;
  onEvent: (phase: string, obj: KubernetesObject) => void;
  onError?: (err: Error) => void;
}

const calls: CapturedCall[] = [];
const callResolvers: Array<() => void> = [];

vi.mock('../client/watch.js', () => ({
  listAndWatch: vi.fn(
    (
      _kc: KubeConfig,
      opts: {
        path: string;
        fieldSelector?: string;
        signal: AbortSignal;
        onEvent: (phase: string, obj: KubernetesObject) => void;
        onError?: (err: Error) => void;
      },
    ) =>
      new Promise<void>((resolve) => {
        const captured: CapturedCall = {
          path: opts.path,
          signal: opts.signal,
          onEvent: opts.onEvent,
        };
        if (opts.fieldSelector !== undefined) captured.fieldSelector = opts.fieldSelector;
        if (opts.onError !== undefined) captured.onError = opts.onError;
        calls.push(captured);
        callResolvers.push(resolve);
        if (opts.signal.aborted) {
          resolve();
          return;
        }
        opts.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  ),
}));

const { createXrWatcher } = await import('../watcher/xr-watcher.js');
const { awaitReady } = await import('../watcher/await-ready.js');

import type { XrEvent, XrRef } from '../watcher/types.js';

const namespacedRef: XrRef = {
  group: 'platform.example.com',
  version: 'v1alpha1',
  plural: 'xprojects',
  kind: 'XProject',
  namespaced: true,
  name: 'foo',
  namespace: 'default',
};

const clusterRef: XrRef = { ...namespacedRef, namespaced: false };
delete (clusterRef as { namespace?: string }).namespace;

function makeXr(opts: { ready?: boolean; uid?: string; xplane?: unknown }): KubernetesObject {
  return {
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'XProject',
    metadata: {
      name: 'foo',
      namespace: 'default',
      uid: opts.uid ?? 'uid-1',
      resourceVersion: '10',
    },
    status: {
      conditions: opts.ready ? [{ type: 'Ready', status: 'True', reason: 'Available' }] : [],
      ...(opts.xplane !== undefined ? { xplane: opts.xplane } : {}),
    },
  } as unknown as KubernetesObject;
}

beforeEach(() => {
  calls.length = 0;
  callResolvers.length = 0;
});

describe('createXrWatcher', () => {
  it('builds the namespaced resource path and applies the name field selector', async () => {
    const w = createXrWatcher({ kubeConfig: {} as KubeConfig, ref: namespacedRef });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/apis/platform.example.com/v1alpha1/namespaces/default/xprojects');
    expect(calls[0]?.fieldSelector).toBe('metadata.name=foo');
    w.stop();
    await w.done;
  });

  it('builds a cluster-scoped path when namespaced is false', async () => {
    const w = createXrWatcher({ kubeConfig: {} as KubeConfig, ref: clusterRef });
    expect(calls[0]?.path).toBe('/apis/platform.example.com/v1alpha1/xprojects');
    w.stop();
    await w.done;
  });

  it('builds a core API path when group is empty', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: { ...clusterRef, group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap' },
    });
    expect(calls[0]?.path).toBe('/api/v1/configmaps');
    w.stop();
    await w.done;
  });

  it('throws when namespaced ref is missing a namespace', () => {
    expect(() =>
      createXrWatcher({
        kubeConfig: {} as KubeConfig,
        ref: { ...namespacedRef, namespace: undefined },
      }),
    ).toThrow(/Namespace is required/);
  });

  it('emits snapshot then ready then end', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    const events: XrEvent[] = [];
    const collect = (async () => {
      for await (const ev of w as AsyncIterable<XrEvent>) events.push(ev);
    })();
    calls[0]?.onEvent('ADDED', makeXr({ ready: true }));
    await new Promise((r) => setImmediate(r));
    w.stop();
    await collect;
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'ready', 'end']);
  });

  it('only emits ready once even if subsequent snapshots are still ready', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    const events: XrEvent[] = [];
    const collect = (async () => {
      for await (const ev of w as AsyncIterable<XrEvent>) events.push(ev);
    })();
    calls[0]?.onEvent('ADDED', makeXr({ ready: true }));
    calls[0]?.onEvent('MODIFIED', makeXr({ ready: true }));
    await new Promise((r) => setImmediate(r));
    w.stop();
    await collect;
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
  });

  it('starts the events watch once the first uid is observed', async () => {
    const w = createXrWatcher({ kubeConfig: {} as KubeConfig, ref: namespacedRef });
    calls[0]?.onEvent('ADDED', makeXr({ ready: false, uid: 'uid-99' }));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe('/api/v1/namespaces/default/events');
    expect(calls[1]?.fieldSelector).toBe('involvedObject.uid=uid-99');
    w.stop();
    await w.done;
  });

  it('does not start the events watch when disableEvents is true', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    calls[0]?.onEvent('ADDED', makeXr({ ready: false }));
    expect(calls).toHaveLength(1);
    w.stop();
    await w.done;
  });

  it('does not start the events watch when the resource is cluster-scoped', async () => {
    const w = createXrWatcher({ kubeConfig: {} as KubeConfig, ref: clusterRef });
    calls[0]?.onEvent('ADDED', makeXr({ ready: false }));
    expect(calls).toHaveLength(1);
    w.stop();
    await w.done;
  });

  it('forwards k8s events and de-dupes by uid', async () => {
    const w = createXrWatcher({ kubeConfig: {} as KubeConfig, ref: namespacedRef });
    const events: XrEvent[] = [];
    const collect = (async () => {
      for await (const ev of w as AsyncIterable<XrEvent>) events.push(ev);
    })();
    calls[0]?.onEvent('ADDED', makeXr({ ready: false }));
    const eventObj = {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { uid: 'evt-1' },
      type: 'Normal',
      reason: 'Created',
      message: 'all set',
      involvedObject: { kind: 'XProject', name: 'foo' },
    } as unknown as KubernetesObject;
    calls[1]?.onEvent('ADDED', eventObj);
    calls[1]?.onEvent('ADDED', eventObj); // duplicate uid
    calls[1]?.onEvent('DELETED', eventObj); // ignored phase
    calls[1]?.onEvent('ADDED', {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: {},
    } as unknown as KubernetesObject); // no message/reason → dropped
    await new Promise((r) => setImmediate(r));
    w.stop();
    await collect;
    expect(events.filter((e) => e.type === 'k8s-event')).toHaveLength(1);
  });

  it('emits error and aborts when the XR is deleted', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    const events: XrEvent[] = [];
    const collect = (async () => {
      for await (const ev of w as AsyncIterable<XrEvent>) events.push(ev);
    })();
    calls[0]?.onEvent('DELETED', makeXr({}));
    await w.done;
    await collect;
    const errEvt = events.find((e) => e.type === 'error');
    expect(errEvt?.type).toBe('error');
  });

  it('forwards errors raised by listAndWatch', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    const events: XrEvent[] = [];
    const collect = (async () => {
      for await (const ev of w as AsyncIterable<XrEvent>) events.push(ev);
    })();
    calls[0]?.onError?.(new Error('boom'));
    await new Promise((r) => setImmediate(r));
    w.stop();
    await collect;
    expect(events.some((e) => e.type === 'error' && /boom/.test(e.error.message))).toBe(true);
  });

  it('ignores BOOKMARK and ERROR phases', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    calls[0]?.onEvent('BOOKMARK', makeXr({}));
    calls[0]?.onEvent('ERROR', makeXr({}));
    w.stop();
    await w.done;
  });

  it('honours an externally provided AbortSignal', async () => {
    const ctrl = new AbortController();
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await w.done;
  });

  it('aborts immediately when the supplied signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      signal: ctrl.signal,
    });
    await w.done;
  });
});

describe('awaitReady', () => {
  it('resolves with the ready snapshot', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    setImmediate(() => calls[0]?.onEvent('ADDED', makeXr({ ready: true })));
    const snap = await awaitReady(w);
    expect(snap.ready).toBe(true);
    w.stop();
    await w.done;
  });

  it('rejects on watcher error', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    setImmediate(() => calls[0]?.onError?.(new Error('nope')));
    await expect(awaitReady(w)).rejects.toThrow('nope');
    w.stop();
    await w.done;
  });

  it('rejects when the watcher ends before ready', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    setImmediate(() => w.stop());
    await expect(awaitReady(w)).rejects.toThrow(/ended before/);
  });

  it('rejects on timeout', async () => {
    const w = createXrWatcher({
      kubeConfig: {} as KubeConfig,
      ref: namespacedRef,
      disableEvents: true,
    });
    await expect(awaitReady(w, { timeoutMs: 10 })).rejects.toThrow(/Timed out/);
    w.stop();
    await w.done;
  });
});
