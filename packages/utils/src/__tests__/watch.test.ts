import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListResult } from '../client/watch.js';

const watchCalls: Array<{
  path: string;
  queryParams: Record<string, unknown>;
  callback: (phase: string, obj: KubernetesObject) => void;
  done: (err: unknown) => void;
  controller: AbortController;
}> = [];

vi.mock('@kubernetes/client-node', () => ({
  Watch: class {
    constructor(public config: KubeConfig) {}
    async watch(
      path: string,
      queryParams: Record<string, unknown>,
      callback: (phase: string, obj: KubernetesObject) => void,
      done: (err: unknown) => void,
    ) {
      const controller = new AbortController();
      watchCalls.push({ path, queryParams, callback, done, controller });
      return controller;
    }
  },
}));

const { listAndWatch } = await import('../client/watch.js');

beforeEach(() => {
  watchCalls.length = 0;
});

describe('listAndWatch', () => {
  it('calls list(), emits ADDED for each item, then watches with the resourceVersion', async () => {
    const list = vi.fn<() => Promise<ListResult>>().mockResolvedValue({
      resourceVersion: '100',
      items: [
        { apiVersion: 'v1', kind: 'X', metadata: { name: 'a' } } as KubernetesObject,
        { apiVersion: 'v1', kind: 'X', metadata: { name: 'b' } } as KubernetesObject,
      ],
    });
    const seen: Array<{ phase: string; name: string | undefined }> = [];
    const ctrl = new AbortController();
    const task = listAndWatch({} as KubeConfig, {
      path: '/p',
      fieldSelector: 'metadata.name=a',
      labelSelector: 'k=v',
      signal: ctrl.signal,
      list,
      onEvent: (phase, obj) => seen.push({ phase, name: obj.metadata?.name }),
    });
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));
    expect(watchCalls[0]?.path).toBe('/p');
    expect(watchCalls[0]?.queryParams).toMatchObject({
      watch: true,
      fieldSelector: 'metadata.name=a',
      labelSelector: 'k=v',
      resourceVersion: '100',
      allowWatchBookmarks: true,
    });
    watchCalls[0]?.callback('MODIFIED', {
      apiVersion: 'v1',
      kind: 'X',
      metadata: { name: 'a', resourceVersion: '101' },
    } as KubernetesObject);
    ctrl.abort();
    await task;
    expect(seen).toEqual([
      { phase: 'ADDED', name: 'a' },
      { phase: 'ADDED', name: 'b' },
      { phase: 'MODIFIED', name: 'a' },
    ]);
  });

  it('re-lists and re-watches when the watch ends with an error', async () => {
    const list = vi
      .fn<() => Promise<ListResult>>()
      .mockResolvedValueOnce({ resourceVersion: '1', items: [] })
      .mockResolvedValueOnce({ resourceVersion: '2', items: [] });
    const errors: string[] = [];
    const ctrl = new AbortController();
    const task = listAndWatch({} as KubeConfig, {
      path: '/p',
      signal: ctrl.signal,
      list,
      onEvent: () => undefined,
      onError: (e) => errors.push(e.message),
    });
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));
    watchCalls[0]?.done(new Error('connection reset'));
    await vi.waitFor(() => expect(watchCalls).toHaveLength(2), { timeout: 3000 });
    ctrl.abort();
    await task;
    expect(errors).toContain('connection reset');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('exits cleanly when the initial list fails and the signal is aborted', async () => {
    const list = vi.fn<() => Promise<ListResult>>().mockRejectedValueOnce(new Error('boom'));
    const errors: string[] = [];
    const ctrl = new AbortController();
    const task = listAndWatch({} as KubeConfig, {
      path: '/p',
      signal: ctrl.signal,
      list,
      onEvent: () => undefined,
      onError: (e) => errors.push(e.message),
    });
    await Promise.resolve();
    ctrl.abort();
    await task;
    expect(errors).toEqual(['boom']);
  });

  it('resolves the inner watch promise when done is called with no error', async () => {
    const list = vi
      .fn<() => Promise<ListResult>>()
      .mockResolvedValueOnce({ resourceVersion: '1', items: [] })
      .mockResolvedValueOnce({ resourceVersion: '2', items: [] });
    const ctrl = new AbortController();
    const task = listAndWatch({} as KubeConfig, {
      path: '/p',
      signal: ctrl.signal,
      list,
      onEvent: () => undefined,
    });
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));
    watchCalls[0]?.done(null);
    await vi.waitFor(() => expect(watchCalls).toHaveLength(2), { timeout: 3000 });
    ctrl.abort();
    await task;
  });

  it('aborts the in-flight watch when the signal fires', async () => {
    const list = vi
      .fn<() => Promise<ListResult>>()
      .mockResolvedValue({ resourceVersion: '1', items: [] });
    const ctrl = new AbortController();
    const task = listAndWatch({} as KubeConfig, {
      path: '/p',
      signal: ctrl.signal,
      list,
      onEvent: () => undefined,
    });
    await vi.waitFor(() => expect(watchCalls).toHaveLength(1));
    const controller = watchCalls[0]?.controller;
    ctrl.abort();
    await new Promise((r) => setImmediate(r));
    expect(controller?.signal.aborted).toBe(true);
    watchCalls[0]?.done(null);
    await task;
  });

  it('rejects when watcher.watch() itself throws', async () => {
    const list = vi
      .fn<() => Promise<ListResult>>()
      .mockResolvedValue({ resourceVersion: '1', items: [] });
    const kc = {} as KubeConfig;
    const mod = await import('@kubernetes/client-node');
    const original = (mod.Watch.prototype as { watch: unknown }).watch;
    (mod.Watch.prototype as { watch: (...args: unknown[]) => Promise<unknown> }).watch = () =>
      Promise.reject(new Error('socket'));
    const errors: string[] = [];
    const ctrl = new AbortController();
    const task = listAndWatch(kc, {
      path: '/p',
      signal: ctrl.signal,
      list,
      onEvent: () => undefined,
      onError: (e) => {
        errors.push(e.message);
        ctrl.abort();
      },
    });
    await task;
    (mod.Watch.prototype as { watch: unknown }).watch = original;
    expect(errors).toContain('socket');
  });
});
