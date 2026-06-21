import type { KubeConfig } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listCrd = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  ApiextensionsV1Api: class {
    listCustomResourceDefinition() {
      return listCrd();
    }
  },
}));

const { listCrdResources, resolveResource } = await import('../cli/discovery.js');

const makeKc = () =>
  ({
    makeApiClient<T>(ctor: new () => T): T {
      return new ctor();
    },
  }) as unknown as KubeConfig;

const crdItem = (
  group: string,
  kind: string,
  plural: string,
  scope: 'Namespaced' | 'Cluster',
  versions: Array<{ name: string; served?: boolean }>,
) => ({ spec: { group, scope, names: { kind, plural }, versions } });

beforeEach(() => {
  listCrd.mockReset();
});

describe('listCrdResources', () => {
  it('flattens served versions and ignores invalid items', async () => {
    listCrd.mockResolvedValue({
      items: [
        crdItem('platform.example.com', 'XProject', 'xprojects', 'Namespaced', [
          { name: 'v1alpha1', served: true },
          { name: 'v1beta1', served: false },
        ]),
        { spec: { group: 'x', names: {}, versions: [] } },
      ],
    });
    const r = await listCrdResources(makeKc());
    expect(r).toEqual([
      {
        group: 'platform.example.com',
        version: 'v1alpha1',
        kind: 'XProject',
        plural: 'xprojects',
        namespaced: true,
      },
    ]);
  });

  it('caches per kubeconfig and invalidates on error', async () => {
    const kc = makeKc();
    listCrd.mockRejectedValueOnce(new Error('boom'));
    await expect(listCrdResources(kc)).rejects.toThrow('boom');
    listCrd.mockResolvedValueOnce({ items: [] });
    await expect(listCrdResources(kc)).resolves.toEqual([]);
    expect(listCrd).toHaveBeenCalledTimes(2);
  });
});

describe('resolveResource', () => {
  beforeEach(() => {
    listCrd.mockResolvedValue({
      items: [
        crdItem('platform.example.com', 'XProject', 'xprojects', 'Namespaced', [
          { name: 'v1alpha1', served: true },
          { name: 'v1beta1', served: true },
        ]),
        crdItem('platform.example.com', 'TideApp', 'tideapps', 'Namespaced', [
          { name: 'v1alpha1', served: true },
        ]),
        crdItem('other.example.com', 'XProject', 'xprojects', 'Namespaced', [
          { name: 'v1', served: true },
        ]),
      ],
    });
  });

  it('matches by plural', async () => {
    const r = await resolveResource(makeKc(), { resource: 'tideapps' });
    expect(r.kind).toBe('TideApp');
  });

  it('matches by kind (case-insensitive)', async () => {
    const r = await resolveResource(makeKc(), { resource: 'tideapp' });
    expect(r.kind).toBe('TideApp');
  });

  it('throws on no match with available kinds list', async () => {
    await expect(resolveResource(makeKc(), { resource: 'nope' })).rejects.toThrow(/No CRD found/);
  });

  it('throws on ambiguous across groups', async () => {
    await expect(resolveResource(makeKc(), { resource: 'xprojects' })).rejects.toThrow(/Ambiguous/);
  });

  it('picks highest version when multiple served in one group', async () => {
    const r = await resolveResource(makeKc(), {
      resource: 'xprojects',
      group: 'platform.example.com',
    });
    expect(r.version).toBe('v1beta1');
  });

  it('honors explicit version', async () => {
    const r = await resolveResource(makeKc(), {
      resource: 'xprojects',
      group: 'platform.example.com',
      version: 'v1alpha1',
    });
    expect(r.version).toBe('v1alpha1');
  });
});
