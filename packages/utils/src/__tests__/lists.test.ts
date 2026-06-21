import type { KubeConfig } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listNs = vi.fn();
const listCluster = vi.fn();
const listEvents = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  CustomObjectsApi: class {
    listNamespacedCustomObject(opts: unknown) {
      return listNs(opts);
    }
    listClusterCustomObject(opts: unknown) {
      return listCluster(opts);
    }
  },
  CoreV1Api: class {
    listNamespacedEvent(opts: unknown) {
      return listEvents(opts);
    }
  },
}));

const { listXrCollection, listXrEvents } = await import('../client/lists.js');

const kc = {
  makeApiClient<T>(ctor: new () => T): T {
    return new ctor();
  },
} as unknown as KubeConfig;

beforeEach(() => {
  listNs.mockReset();
  listCluster.mockReset();
  listEvents.mockReset();
});

describe('listXrCollection', () => {
  it('uses listNamespacedCustomObject for namespaced refs', async () => {
    listNs.mockResolvedValue({ metadata: { resourceVersion: '7' }, items: [{ a: 1 }] });
    const res = await listXrCollection(kc, {
      group: 'g',
      version: 'v',
      plural: 'xs',
      kind: 'X',
      namespaced: true,
      name: 'n',
      namespace: 'ns',
    });
    expect(listNs).toHaveBeenCalledWith({
      group: 'g',
      version: 'v',
      namespace: 'ns',
      plural: 'xs',
      fieldSelector: 'metadata.name=n',
    });
    expect(res.resourceVersion).toBe('7');
    expect(res.items).toHaveLength(1);
  });

  it('uses listClusterCustomObject for cluster-scoped refs', async () => {
    listCluster.mockResolvedValue({ items: [] });
    const res = await listXrCollection(kc, {
      group: 'g',
      version: 'v',
      plural: 'xs',
      kind: 'X',
      namespaced: false,
      name: 'n',
    });
    expect(listCluster).toHaveBeenCalledWith({
      group: 'g',
      version: 'v',
      plural: 'xs',
      fieldSelector: 'metadata.name=n',
    });
    expect(res.resourceVersion).toBe('');
    expect(res.items).toEqual([]);
  });
});

describe('listXrEvents', () => {
  it('calls listNamespacedEvent and returns items + resourceVersion', async () => {
    listEvents.mockResolvedValue({
      metadata: { resourceVersion: '42' },
      items: [{ message: 'hi' }],
    });
    const res = await listXrEvents(kc, 'ns', 'involvedObject.uid=u');
    expect(listEvents).toHaveBeenCalledWith({
      namespace: 'ns',
      fieldSelector: 'involvedObject.uid=u',
    });
    expect(res.resourceVersion).toBe('42');
    expect(res.items).toHaveLength(1);
  });

  it('returns empty items when none', async () => {
    listEvents.mockResolvedValue({});
    const res = await listXrEvents(kc, 'ns', 'fs');
    expect(res.items).toEqual([]);
    expect(res.resourceVersion).toBe('');
  });
});
