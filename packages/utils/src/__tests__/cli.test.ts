import type { KubeConfig } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedResource } from '../cli/discovery.js';
import { parseDuration } from '../cli/duration.js';
import { runWatchCommand } from '../cli/watch.js';
import type { XrSnapshot } from '../watcher/types.js';
import type { XrWatcher } from '../watcher/xr-watcher.js';

describe('parseDuration', () => {
  it.each([
    ['', undefined],
    [undefined, undefined],
    ['500', 500],
    ['250ms', 250],
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input as string | undefined)).toBe(expected);
  });

  it('throws on invalid input', () => {
    expect(() => parseDuration('forever')).toThrow(/Invalid duration/);
  });
});

const resolved: ResolvedResource = {
  group: 'platform.example.com',
  version: 'v1alpha1',
  kind: 'XProject',
  plural: 'xprojects',
  namespaced: true,
};

function fakeWatcher(): XrWatcher {
  return {
    ready: new Promise(() => undefined),
    done: Promise.resolve(),
    stop: vi.fn(),
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined, done: true }),
    }),
  };
}

describe('runWatchCommand', () => {
  it('returns code=0 when the XR becomes Ready', async () => {
    const watcher = fakeWatcher();
    const render = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue({ ready: true } as XrSnapshot);
    const result = await runWatchCommand(
      { target: 'xprojects/foo', namespace: 'default', timeout: '5s', mode: 'ci' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        createXrWatcher: vi.fn().mockReturnValue(watcher),
        runRenderer: render,
        awaitReady: wait,
      },
    );
    expect(result).toEqual({ code: 0 });
    expect(watcher.stop).toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith(watcher, { timeoutMs: 5000 });
  });

  it('errors when namespaced XR is missing namespace', async () => {
    const result = await runWatchCommand(
      { target: 'xprojects/foo' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        createXrWatcher: vi.fn(),
        runRenderer: vi.fn(),
        awaitReady: vi.fn(),
      },
    );
    expect(result.code).toBe(1);
    expect((result as { error: string }).error).toMatch(/namespaced/);
  });

  it('returns code=1 (without error string) when awaitReady rejects — renderer surfaces the message', async () => {
    const watcher = fakeWatcher();
    const result = await runWatchCommand(
      { target: 'xclusters/bar' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        createXrWatcher: vi.fn().mockReturnValue(watcher),
        runRenderer: vi.fn().mockResolvedValue(undefined),
        awaitReady: vi.fn().mockRejectedValue(new Error('timeout')),
      },
    );
    expect(result).toEqual({ code: 1 });
  });

  it('returns code=1 (without error string) for non-Error rejections too', async () => {
    const watcher = fakeWatcher();
    const result = await runWatchCommand(
      { target: 'xclusters/bar' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        createXrWatcher: vi.fn().mockReturnValue(watcher),
        runRenderer: vi.fn().mockResolvedValue(undefined),
        awaitReady: vi.fn().mockRejectedValue('plain'),
      },
    );
    expect(result).toEqual({ code: 1 });
  });

  it('passes through kubeconfig/context and forwards disableEvents', async () => {
    const load = vi.fn().mockReturnValue({} as KubeConfig);
    const factory = vi.fn().mockReturnValue(fakeWatcher());
    await runWatchCommand(
      {
        target: 'xprojects/foo',
        namespace: 'default',
        kubeconfig: '/tmp/kc',
        context: 'ctx',
        disableEvents: true,
      },
      {
        loadKubeConfig: load,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        createXrWatcher: factory,
        runRenderer: vi.fn().mockResolvedValue(undefined),
        awaitReady: vi.fn().mockResolvedValue({} as XrSnapshot),
      },
    );
    expect(load).toHaveBeenCalledWith({ kubeconfig: '/tmp/kc', context: 'ctx' });
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ disableEvents: true });
  });
});
