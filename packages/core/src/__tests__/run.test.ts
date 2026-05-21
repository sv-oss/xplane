import { describe, expect, it } from 'vitest';
import type { CompositionInput } from '../contract.js';
import { Composition } from '../core/composition.js';
import { Resource } from '../core/resource.js';
import { runComposition } from '../run.js';

function emptyInput(overrides: Partial<CompositionInput> = {}): CompositionInput {
  return {
    xr: { spec: {}, status: {} },
    pipelineContext: {},
    observedComposed: {},
    observedRequired: {},
    ...overrides,
  };
}

describe('runComposition', () => {
  it('returns emitted resources as plain data', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          spec: { forProvider: { cidrBlock: '10.0.0.0/16' } },
        });
      }
    }

    const result = runComposition(TestComp, emptyInput());

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.name).toBe('vpc');
    expect(result.resources[0]!.document).toMatchObject({
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'VPC',
      spec: { forProvider: { cidrBlock: '10.0.0.0/16' } },
    });
    expect(result.resources[0]!.ready).toBe(false); // no observed → not ready
  });

  it('marks resources as ready when observed state exists', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        new Resource(this, 'cm', {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          data: { key: 'value' },
        });
      }
    }

    const result = runComposition(
      TestComp,
      emptyInput({
        observedComposed: {
          'Composition/cm': {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            status: { conditions: [{ type: 'Ready', status: 'True' }] },
          },
        },
      }),
    );

    expect(result.resources[0]!.ready).toBe(true);
  });

  it('reads XR spec values', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        new Resource(this, 'bucket', {
          apiVersion: 'storage.gcp.upbound.io/v1beta1',
          kind: 'Bucket',
          spec: { forProvider: { location: this.xr.spec.region } },
        });
      }
    }

    const result = runComposition(
      TestComp,
      emptyInput({ xr: { spec: { region: 'us-east-1' }, status: {} } }),
    );

    expect(result.resources[0]!.document).toMatchObject({
      spec: { forProvider: { location: 'us-east-1' } },
    });
  });

  it('captures XR status patches', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        this.xr.status.ready = true;
        this.xr.status.message = 'provisioned';
      }
    }

    const result = runComposition(TestComp, emptyInput());

    expect(result.xrStatus).toEqual({ ready: true, message: 'provisioned' });
  });

  it('tracks cross-resource dependencies and blocks unresolved', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          spec: { forProvider: { cidrBlock: '10.0.0.0/16' } },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
          spec: { forProvider: { vpcId: (vpc as any).status.atProvider.vpcId } },
        });
      }
    }

    // Without observed vpc → subnet is blocked
    const result = runComposition(TestComp, emptyInput());

    expect(result.resources).toHaveLength(1); // only vpc emitted
    expect(result.resources[0]!.name).toBe('vpc');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.resource).toContain('subnet');
    expect(result.diagnostics[0]!.reason).toBe('pending');
  });

  it('resolves dependencies when observed state is available', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          spec: { forProvider: { cidrBlock: '10.0.0.0/16' } },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
          spec: { forProvider: { vpcId: (vpc as any).status.atProvider.vpcId } },
        });
      }
    }

    const result = runComposition(
      TestComp,
      emptyInput({
        observedComposed: {
          'Composition/vpc': {
            apiVersion: 'ec2.aws.crossplane.io/v1beta1',
            kind: 'VPC',
            status: { atProvider: { vpcId: 'vpc-123' } },
          },
        },
      }),
    );

    // Both emitted now
    expect(result.resources).toHaveLength(2);
    const subnet = result.resources.find((r) => r.name === 'subnet')!;
    expect(subnet.document).toMatchObject({
      spec: { forProvider: { vpcId: 'vpc-123' } },
    });
    expect(result.diagnostics).toHaveLength(0);
  });

  it('collects external resource requests', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        Resource.fromExistingByName(this, 'v1', 'Secret', 'db-creds', 'default');
      }
    }

    const result = runComposition(TestComp, emptyInput());

    expect(result.externalResources).toHaveLength(1);
    expect(result.externalResources[0]).toMatchObject({
      apiVersion: 'v1',
      kind: 'Secret',
      name: 'db-creds',
      namespace: 'default',
    });
    expect(result.externalResources[0]!.refKey).toBeDefined();
  });

  it('passes pipeline context to composition', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        const env = this.pipelineContext.get('environment');
        new Resource(this, 'cm', {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          data: { env: env as string },
        });
      }
    }

    const result = runComposition(
      TestComp,
      emptyInput({ pipelineContext: { environment: 'production' } }),
    );

    expect(result.resources[0]!.document).toMatchObject({
      data: { env: 'production' },
    });
  });

  it('throws when composition constructor throws', () => {
    class BrokenComp extends Composition {
      constructor() {
        super();
        throw new Error('oops');
      }
    }

    expect(() => runComposition(BrokenComp, emptyInput())).toThrow('oops');
  });

  it('marks resource as ready when autoReady is disabled', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        const r = new Resource(this, 'manual', {
          apiVersion: 'v1',
          kind: 'ConfigMap',
        });
        r.resource.autoReady = false;
      }
    }

    const result = runComposition(TestComp, emptyInput());

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.ready).toBe(true); // always ready when autoReady=false
  });

  it('skips external resources with pending name', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        // Create an external resource that reads from an unresolved proxy
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
        });
        // This creates an external ref with a pending name
        Resource.fromExistingByName(
          this,
          'v1',
          'Secret',
          // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
          (vpc as any).status.atProvider.secretName,
        );
      }
    }

    const result = runComposition(TestComp, emptyInput());

    // External resource should be skipped (pending name)
    expect(result.externalResources).toHaveLength(0);
  });

  it('includes namespace in external resource requests when provided', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        Resource.fromExistingByName(this, 'v1', 'Secret', 'my-secret', 'kube-system');
      }
    }

    const result = runComposition(TestComp, emptyInput());

    expect(result.externalResources).toHaveLength(1);
    expect(result.externalResources[0]!.namespace).toBe('kube-system');
  });

  it('omits namespace from external resource when not provided', () => {
    class TestComp extends Composition {
      constructor() {
        super();
        Resource.fromExistingByName(this, 'v1', 'ConfigMap', 'global-config');
      }
    }

    const result = runComposition(TestComp, emptyInput());

    expect(result.externalResources).toHaveLength(1);
    expect(result.externalResources[0]!.namespace).toBeUndefined();
  });
});
