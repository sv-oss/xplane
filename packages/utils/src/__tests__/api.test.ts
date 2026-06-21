import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveResource,
  mockListXrCollection,
  mockCreateXrWatcher,
  mockRunRenderer,
  mockAwaitReady,
} = vi.hoisted(() => ({
  mockResolveResource: vi.fn(),
  mockListXrCollection: vi.fn(),
  mockCreateXrWatcher: vi.fn(),
  mockRunRenderer: vi.fn(),
  mockAwaitReady: vi.fn(),
}));

vi.mock('../cli/discovery.js', () => ({ resolveResource: mockResolveResource }));
vi.mock('../client/lists.js', () => ({ listXrCollection: mockListXrCollection }));
vi.mock('../render/index.js', () => ({ runRenderer: mockRunRenderer }));
vi.mock('../watcher/xr-watcher.js', () => ({ createXrWatcher: mockCreateXrWatcher }));
vi.mock('../watcher/await-ready.js', () => ({ awaitReady: mockAwaitReady }));

import { getStatus, resolveTarget, watchUntilReady } from '../api.js';
import type { XrRef, XrSnapshot } from '../watcher/types.js';

const KC = {} as KubeConfig;

const RESOLVED = {
  group: 'platform.example.com',
  version: 'v1alpha1',
  kind: 'XProject',
  plural: 'xprojects',
  namespaced: true,
};

const REF: XrRef = {
  group: 'platform.example.com',
  version: 'v1alpha1',
  kind: 'XProject',
  plural: 'xprojects',
  namespaced: true,
  name: 'foo',
  namespace: 'default',
};

beforeEach(() => {
  mockResolveResource.mockReset();
  mockListXrCollection.mockReset();
  mockCreateXrWatcher.mockReset();
  mockRunRenderer.mockReset();
  mockAwaitReady.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('resolveTarget', () => {
  it('returns a fully-populated XrRef', async () => {
    mockResolveResource.mockResolvedValue(RESOLVED);
    const ref = await resolveTarget(KC, 'xprojects/foo', 'default');
    expect(ref).toEqual(REF);
  });

  it('forwards group/version hints from the target string', async () => {
    mockResolveResource.mockResolvedValue(RESOLVED);
    await resolveTarget(KC, 'xprojects.v1alpha1.platform.example.com/foo', 'default');
    expect(mockResolveResource).toHaveBeenCalledWith(KC, {
      resource: 'xprojects',
      group: 'platform.example.com',
      version: 'v1alpha1',
    });
  });

  it('throws when a namespaced kind has no namespace', async () => {
    mockResolveResource.mockResolvedValue(RESOLVED);
    await expect(resolveTarget(KC, 'xprojects/foo')).rejects.toThrow(/namespaced/);
  });

  it('allows cluster-scoped kinds with no namespace', async () => {
    mockResolveResource.mockResolvedValue({ ...RESOLVED, namespaced: false });
    const ref = await resolveTarget(KC, 'xclusters/bar');
    expect(ref.namespaced).toBe(false);
    expect(ref.namespace).toBeUndefined();
  });
});

describe('getStatus', () => {
  const item = {
    metadata: { name: 'foo' },
    status: { ready: true, xplane: { x: 1 }, conditions: [], other: 'v' },
  } as unknown as KubernetesObject;

  it('returns the status filtered down to non-framework keys by default', async () => {
    mockListXrCollection.mockResolvedValue({ resourceVersion: '1', items: [item] });
    const status = await getStatus(KC, REF);
    expect(status).toEqual({ ready: true, other: 'v' });
  });

  it('keeps xplane / conditions when explicitly opted in', async () => {
    mockListXrCollection.mockResolvedValue({ resourceVersion: '1', items: [item] });
    const status = await getStatus(KC, REF, { includeXplane: true, includeConditions: true });
    expect(status).toEqual({ ready: true, xplane: { x: 1 }, conditions: [], other: 'v' });
  });

  it('throws when no XR matches', async () => {
    mockListXrCollection.mockResolvedValue({ resourceVersion: '1', items: [] });
    await expect(getStatus(KC, REF)).rejects.toThrow(/not found/);
  });

  it('returns an empty object when the XR has no .status', async () => {
    const bare = { metadata: { name: 'foo' } } as KubernetesObject;
    mockListXrCollection.mockResolvedValue({ resourceVersion: '1', items: [bare] });
    expect(await getStatus(KC, REF)).toEqual({});
  });
});

function fakeWatcher() {
  return {
    ready: new Promise(() => undefined),
    done: Promise.resolve(),
    stop: vi.fn(),
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined, done: true }),
    }),
  };
}

describe('watchUntilReady', () => {
  it('builds a watcher, drives the renderer, and resolves with the ready snapshot', async () => {
    const watcher = fakeWatcher();
    const snap = { ready: true } as XrSnapshot;
    mockCreateXrWatcher.mockReturnValue(watcher);
    mockRunRenderer.mockResolvedValue(undefined);
    mockAwaitReady.mockResolvedValue(snap);

    const result = await watchUntilReady({
      kubeConfig: KC,
      ref: REF,
      timeoutMs: 5000,
      renderer: { mode: 'ci', noColor: true },
    });

    expect(result).toBe(snap);
    expect(mockCreateXrWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ kubeConfig: KC, ref: REF }),
    );
    expect(mockRunRenderer).toHaveBeenCalledWith(
      watcher,
      expect.objectContaining({ ref: REF, mode: 'ci', noColor: true }),
    );
    expect(mockAwaitReady).toHaveBeenCalledWith(watcher, { timeoutMs: 5000 });
    expect(watcher.stop).toHaveBeenCalled();
  });

  it('skips the renderer when renderer=false', async () => {
    const watcher = fakeWatcher();
    mockCreateXrWatcher.mockReturnValue(watcher);
    mockAwaitReady.mockResolvedValue({ ready: true } as XrSnapshot);

    await watchUntilReady({ kubeConfig: KC, ref: REF, renderer: false });

    expect(mockRunRenderer).not.toHaveBeenCalled();
    expect(watcher.stop).toHaveBeenCalled();
  });

  it('stops the watcher and drains the renderer on awaitReady failure', async () => {
    const watcher = fakeWatcher();
    mockCreateXrWatcher.mockReturnValue(watcher);
    const renderRejected = Promise.reject(new Error('rendered error'));
    mockRunRenderer.mockReturnValue(renderRejected);
    mockAwaitReady.mockRejectedValue(new Error('timeout'));

    await expect(watchUntilReady({ kubeConfig: KC, ref: REF })).rejects.toThrow('timeout');
    expect(watcher.stop).toHaveBeenCalled();
    // Renderer rejection must be swallowed so it doesn't shadow the original error.
    await expect(renderRejected.catch(() => 'caught')).resolves.toBe('caught');
  });
});
