import type { CompositionInput } from '@xplane/core';
import { describe, expect, it } from 'vitest';
import { InlineLoader } from '../loader/inline.js';

const baseInput: CompositionInput = {
  xr: { spec: {}, status: {} },
  pipelineContext: {},
  observedComposed: {},
  observedRequired: {},
};

describe('InlineLoader', () => {
  const loader = new InlineLoader();

  it('throws if input.spec is missing', async () => {
    await expect(loader.load({})).rejects.toThrow('input.spec must be an object');
  });

  it('throws if input.spec.code is not a string', async () => {
    await expect(loader.load({ spec: { code: 42 } })).rejects.toThrow(
      'input.spec.code must be a string',
    );
  });

  it('throws if input.spec.code is empty', async () => {
    await expect(loader.load({ spec: { code: '  ' } })).rejects.toThrow('input.spec.code is empty');
  });

  it("throws if no 'run' export is present", async () => {
    await expect(loader.load({ spec: { code: 'const x = 1;' } })).rejects.toThrow(
      "must export a 'run' function",
    );
  });

  it('throws on syntax errors in user code', async () => {
    await expect(loader.load({ spec: { code: 'class { broken' } })).rejects.toThrow(
      'Failed to evaluate composition code',
    );
  });

  it('loads a valid composition and returns a runnable module', async () => {
    const code = `
      class MyComposition extends Composition {
        constructor() {
          super();
          new Resource(this, 'vpc', {
            apiVersion: 'ec2.aws.upbound.io/v1beta1',
            kind: 'VPC',
            spec: { forProvider: { cidrBlock: '10.0.0.0/16' } },
          });
        }
      }
      exports.run = (input) => runComposition(MyComposition, input);
    `;

    const mod = await loader.load({ spec: { code } });
    expect(typeof mod.run).toBe('function');
    const result = mod.run(baseInput);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.nodePath).toBe('vpc');
  });

  it('provides standard globals to user code', async () => {
    const code = `
      class TestGlobals extends Composition {
        constructor() {
          super();
          const encoded = btoa("hello");
          const decoded = atob(encoded);
          const url = new URL("https://example.com");
          const map = new Map();
          const set = new Set();

          new Resource(this, 'test', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            spec: { data: { encoded, decoded, host: url.host } },
          });
        }
      }
      exports.run = (input) => runComposition(TestGlobals, input);
    `;

    const mod = await loader.load({ spec: { code } });
    const result = mod.run(baseInput);
    expect(result.resources).toHaveLength(1);
  });

  it('supports cross-resource dependency detection (blocked resources)', async () => {
    const code = `
      class CrossDep extends Composition {
        constructor() {
          super();
          const vpc = new Resource(this, 'vpc', {
            apiVersion: 'ec2.aws.upbound.io/v1beta1',
            kind: 'VPC',
          });
          const subnet = new Resource(this, 'subnet', {
            apiVersion: 'ec2.aws.upbound.io/v1beta1',
            kind: 'Subnet',
            spec: { forProvider: {} },
          });
          subnet.spec.forProvider.vpcId = vpc.status.atProvider.vpcId;
        }
      }
      exports.run = (input) => runComposition(CrossDep, input);
    `;

    const mod = await loader.load({ spec: { code } });
    const result = mod.run(baseInput);
    // vpc should emit, subnet should be blocked (waiting on vpc's observed status)
    expect(result.resources.some((r) => r.nodePath === 'vpc')).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  it('supports reading XR values', async () => {
    const code = `
      class XrRead extends Composition {
        constructor() {
          super();
          new Resource(this, 'vpc', {
            apiVersion: 'ec2.aws.upbound.io/v1beta1',
            kind: 'VPC',
            spec: { forProvider: { cidrBlock: this.xr.spec.cidrBlock } },
          });
        }
      }
      exports.run = (input) => runComposition(XrRead, input);
    `;

    const mod = await loader.load({ spec: { code } });
    const result = mod.run({
      ...baseInput,
      xr: { spec: { cidrBlock: '10.0.0.0/16' }, status: {} },
    });
    expect(result.resources).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: document is Record<string, unknown>, deep access needs any
    expect((result.resources[0]!.document as Record<string, any>).spec.forProvider.cidrBlock).toBe(
      '10.0.0.0/16',
    );
  });
});
