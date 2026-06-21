import type { KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedResource } from '../cli/discovery.js';
import { runGetStatusCommand, toDotLines } from '../cli/get-status.js';

const resolved: ResolvedResource = {
  group: 'platform.example.com',
  version: 'v1alpha1',
  kind: 'XProject',
  plural: 'xprojects',
  namespaced: true,
};

interface Out {
  readonly stream: NodeJS.WritableStream;
  readonly text: () => string;
}

function makeOut(): Out {
  let written = '';
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => written };
}

describe('toDotLines', () => {
  it('flattens nested objects with dot notation', () => {
    expect(toDotLines({ a: { b: { c: 1 } } })).toEqual(['a.b.c=1']);
  });

  it('indexes arrays', () => {
    expect(toDotLines({ items: [{ name: 'a' }, { name: 'b' }] })).toEqual([
      'items[0].name="a"',
      'items[1].name="b"',
    ]);
  });

  it('represents primitives as JSON-encoded leaves', () => {
    expect(toDotLines({ s: 'x', n: 1, b: true, z: null })).toEqual([
      's="x"',
      'n=1',
      'b=true',
      'z=null',
    ]);
  });

  it('handles empty collections explicitly', () => {
    expect(toDotLines({ a: [], b: {} })).toEqual(['a=[]', 'b={}']);
  });

  it('emits "." when the root itself is empty', () => {
    expect(toDotLines({})).toEqual(['.={}']);
    expect(toDotLines([])).toEqual(['.=[]']);
    expect(toDotLines(null)).toEqual(['.=null']);
  });

  it('returns no lines for undefined', () => {
    expect(toDotLines(undefined)).toEqual([]);
  });
});

describe('runGetStatusCommand', () => {
  const xrItem = {
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'XProject',
    metadata: { name: 'foo', namespace: 'default' },
    status: {
      ready: true,
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  } as unknown as KubernetesObject;

  it('prints status as dot lines by default', async () => {
    const out = makeOut();
    const list = vi.fn().mockResolvedValue({ resourceVersion: '1', items: [xrItem] });
    const result = await runGetStatusCommand(
      { target: 'xprojects/foo', namespace: 'default' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: list,
        out: out.stream,
      },
    );
    expect(result).toEqual({ code: 0 });
    expect(out.text()).toBe('ready=true\n');
    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'XProject',
        namespace: 'default',
        name: 'foo',
      }),
    );
  });

  it('prints status as JSON when format=json', async () => {
    const out = makeOut();
    const result = await runGetStatusCommand(
      { target: 'xprojects/foo', namespace: 'default', format: 'json' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: vi.fn().mockResolvedValue({ resourceVersion: '1', items: [xrItem] }),
        out: out.stream,
      },
    );
    expect(result).toEqual({ code: 0 });
    expect(JSON.parse(out.text())).toEqual({ ready: true });
    expect(out.text()).toContain('\n  '); // pretty-printed
  });

  it('emits compact JSON when pretty=false', async () => {
    const out = makeOut();
    await runGetStatusCommand(
      { target: 'xprojects/foo', namespace: 'default', format: 'json', pretty: false },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: vi.fn().mockResolvedValue({ resourceVersion: '1', items: [xrItem] }),
        out: out.stream,
      },
    );
    expect(out.text()).toBe('{"ready":true}\n');
  });

  it('returns code=1 when the XR is not found', async () => {
    const out = makeOut();
    const result = await runGetStatusCommand(
      { target: 'xprojects/missing', namespace: 'default' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: vi.fn().mockResolvedValue({ resourceVersion: '0', items: [] }),
        out: out.stream,
      },
    );
    expect(result.code).toBe(1);
    expect((result as { error: string }).error).toMatch(/XProject\/missing.*not found/);
    expect(out.text()).toBe('');
  });

  it('errors when namespaced XR is missing namespace', async () => {
    const result = await runGetStatusCommand(
      { target: 'xprojects/foo' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: vi.fn(),
      },
    );
    expect(result.code).toBe(1);
    expect((result as { error: string }).error).toMatch(/namespaced/);
  });

  it('treats a missing status as empty', async () => {
    const out = makeOut();
    const item = { metadata: { name: 'foo' } } as KubernetesObject;
    const result = await runGetStatusCommand(
      { target: 'xclusters/foo' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        listXrCollection: vi.fn().mockResolvedValue({ resourceVersion: '1', items: [item] }),
        out: out.stream,
      },
    );
    expect(result).toEqual({ code: 0 });
    expect(out.text()).toBe('.={}\n');
  });

  it('strips status.xplane by default and keeps it with includeXplane', async () => {
    const item = {
      metadata: { name: 'foo' },
      status: { ready: true, xplane: { emittedResources: [{ nodePath: 'a' }] } },
    } as unknown as KubernetesObject;
    const list = vi.fn().mockResolvedValue({ resourceVersion: '1', items: [item] });

    const outA = makeOut();
    await runGetStatusCommand(
      { target: 'xclusters/foo' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        listXrCollection: list,
        out: outA.stream,
      },
    );
    expect(outA.text()).toBe('ready=true\n');

    const outB = makeOut();
    await runGetStatusCommand(
      { target: 'xclusters/foo', includeXplane: true },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        listXrCollection: list,
        out: outB.stream,
      },
    );
    expect(outB.text()).toContain('xplane.emittedResources[0].nodePath="a"');
  });

  it('strips status.conditions by default and keeps it with includeConditions', async () => {
    const item = {
      metadata: { name: 'foo' },
      status: { ready: true, conditions: [{ type: 'Ready', status: 'True' }] },
    } as unknown as KubernetesObject;
    const list = vi.fn().mockResolvedValue({ resourceVersion: '1', items: [item] });

    const outA = makeOut();
    await runGetStatusCommand(
      { target: 'xclusters/foo' },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        listXrCollection: list,
        out: outA.stream,
      },
    );
    expect(outA.text()).toBe('ready=true\n');

    const outB = makeOut();
    await runGetStatusCommand(
      { target: 'xclusters/foo', includeConditions: true },
      {
        loadKubeConfig: () => ({}) as KubeConfig,
        resolveResource: vi.fn().mockResolvedValue({ ...resolved, namespaced: false }),
        listXrCollection: list,
        out: outB.stream,
      },
    );
    expect(outB.text()).toContain('conditions[0].type="Ready"');
  });

  it('forwards kubeconfig + context options', async () => {
    const load = vi.fn().mockReturnValue({} as KubeConfig);
    await runGetStatusCommand(
      {
        target: 'xprojects/foo',
        namespace: 'default',
        kubeconfig: '/tmp/kc',
        context: 'ctx',
      },
      {
        loadKubeConfig: load,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: vi.fn().mockResolvedValue({ resourceVersion: '1', items: [xrItem] }),
        out: makeOut().stream,
      },
    );
    expect(load).toHaveBeenCalledWith({ kubeconfig: '/tmp/kc', context: 'ctx' });
  });

  it('uses a pre-built kubeConfig when provided', async () => {
    const load = vi.fn();
    const list = vi.fn().mockResolvedValue({ resourceVersion: '1', items: [xrItem] });
    const userKc = { brand: 'user' } as unknown as KubeConfig;
    await runGetStatusCommand(
      { target: 'xprojects/foo', namespace: 'default', kubeConfig: userKc },
      {
        loadKubeConfig: load,
        resolveResource: vi.fn().mockResolvedValue(resolved),
        listXrCollection: list,
        out: makeOut().stream,
      },
    );
    expect(load).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(userKc, expect.anything());
  });

  it('rejects mixing kubeConfig with kubeconfig/context', async () => {
    const result = await runGetStatusCommand(
      {
        target: 'xprojects/foo',
        namespace: 'default',
        kubeConfig: {} as KubeConfig,
        context: 'ctx',
      },
      {
        loadKubeConfig: vi.fn(),
        resolveResource: vi.fn(),
        listXrCollection: vi.fn(),
      },
    );
    expect(result.code).toBe(1);
    expect((result as { error: string }).error).toMatch(/either kubeConfig or kubeconfig/);
  });
});
