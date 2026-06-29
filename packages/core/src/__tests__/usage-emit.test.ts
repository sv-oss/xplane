/* biome-ignore-all lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime */
import { describe, expect, it } from 'vitest';

import type { CompositionInput, DesiredResource } from '../contract.js';
import { Composition } from '../core/composition.js';
import { Resource } from '../core/resource.js';
import { runComposition } from '../run.js';
import {
  buildUsageReason,
  SYNTHETIC_ANNOTATION_KEY,
  SYNTHETIC_USAGE_VALUE,
  USAGE_API_VERSION,
  usageResourceName,
} from '../usage/index.js';

function input(overrides: Partial<CompositionInput> = {}): CompositionInput {
  return {
    xr: { spec: {}, status: {} },
    pipelineContext: {},
    observedComposed: {},
    observedRequired: {},
    ...overrides,
  };
}

function findUsage(
  resources: DesiredResource[],
  kind: 'Usage' | 'ClusterUsage',
): DesiredResource | undefined {
  return resources.find((r) => {
    const doc = r.document;
    return doc.apiVersion === USAGE_API_VERSION && doc.kind === kind;
  });
}

function annotations(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = doc.metadata as Record<string, unknown> | undefined;
  return meta?.annotations as Record<string, unknown> | undefined;
}

function spec(doc: Record<string, unknown>): Record<string, unknown> {
  return doc.spec as Record<string, unknown>;
}

const VPC_OBSERVED = {
  apiVersion: 'ec2.aws.crossplane.io/v1beta1',
  kind: 'VPC',
  metadata: { name: 'my-vpc' },
  status: { atProvider: { id: 'vpc-123' } },
};

const SUBNET_OBSERVED_NAMESPACED = {
  apiVersion: 'ec2.aws.crossplane.io/v1beta1',
  kind: 'Subnet',
  metadata: { name: 'my-subnet', namespace: 'team-a' },
  status: {},
};

const SUBNET_OBSERVED_CLUSTER = {
  apiVersion: 'ec2.aws.crossplane.io/v1beta1',
  kind: 'Subnet',
  metadata: { name: 'my-subnet' },
  status: {},
};

describe('buildUsageResources', () => {
  it('emits nothing when emitUsageEdges is false', () => {
    class Comp extends Composition {
      constructor() {
        super();
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
      }
    }
    const result = runComposition(Comp, input());
    expect(findUsage(result.resources, 'Usage')).toBeUndefined();
    expect(findUsage(result.resources, 'ClusterUsage')).toBeUndefined();
  });

  it('emits a namespaced Usage when dependent observed has a namespace', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet', namespace: 'team-a' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnet': SUBNET_OBSERVED_NAMESPACED,
        },
      }),
    );
    const usage = findUsage(result.resources, 'Usage');
    expect(usage).toBeDefined();
    const doc = usage!.document;
    expect((doc.metadata as Record<string, unknown>).namespace).toBe('team-a');
    expect(annotations(doc)?.[SYNTHETIC_ANNOTATION_KEY]).toBe(SYNTHETIC_USAGE_VALUE);
    expect(spec(doc).by).toMatchObject({
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'Subnet',
      resourceRef: { name: 'my-subnet' },
    });
    expect(spec(doc).of).toMatchObject({
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'VPC',
      resourceRef: { name: 'my-vpc' },
    });
    expect(spec(doc).reason).toMatch(/needs VPC\/my-vpc fields \[status.atProvider.id\]/);
    expect(spec(doc).replayDeletion).toBeUndefined();
  });

  it('emits a ClusterUsage when dependent observed has no namespace', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnet': SUBNET_OBSERVED_CLUSTER,
        },
      }),
    );
    const usage = findUsage(result.resources, 'ClusterUsage');
    expect(usage).toBeDefined();
    expect((usage!.document.metadata as Record<string, unknown>).namespace).toBeUndefined();
  });

  it('skips when dependent has no observed state (first reconcile)', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
      }
    }
    // Only vpc has observed — subnet (dependent) does not.
    const result = runComposition(
      Comp,
      input({ observedComposed: { 'Composition/vpc': VPC_OBSERVED } }),
    );
    expect(findUsage(result.resources, 'Usage')).toBeUndefined();
    expect(findUsage(result.resources, 'ClusterUsage')).toBeUndefined();
  });

  it('emits Usage for node.addDependency-only edges with the explicit reason form', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        const subnet = new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
        });
        subnet.node.addDependency(vpc);
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnet': SUBNET_OBSERVED_CLUSTER,
        },
      }),
    );
    const usage = findUsage(result.resources, 'ClusterUsage');
    expect(usage).toBeDefined();
    expect(spec(usage!.document).reason).toMatch(
      /Subnet\/my-subnet explicitly depends on VPC\/my-vpc/,
    );
  });

  it('collapses multiple field-level edges into a single Usage with sorted paths', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
          spec: {
            vpcId: (vpc as any).status.atProvider.id,
            cidrBlock: (vpc as any).status.atProvider.cidrBlock,
          },
        });
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': {
            ...VPC_OBSERVED,
            status: { atProvider: { id: 'vpc-123', cidrBlock: '10.0.0.0/16' } },
          },
          'Composition/subnet': SUBNET_OBSERVED_CLUSTER,
        },
      }),
    );
    const usages = result.resources.filter((r) => r.document.kind === 'ClusterUsage');
    expect(usages).toHaveLength(1);
    expect(spec(usages[0]!.document).reason).toMatch(
      /\[status.atProvider.cidrBlock, status.atProvider.id\]/,
    );
  });

  it('collapses a field-level edge with an explicit addDependency on the same pair', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        const subnet = new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
        subnet.node.addDependency(vpc);
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnet': SUBNET_OBSERVED_CLUSTER,
        },
      }),
    );
    const usages = result.resources.filter((r) => r.document.kind === 'ClusterUsage');
    expect(usages).toHaveLength(1);
    expect(spec(usages[0]!.document).reason).toMatch(/needs VPC\/my-vpc fields \[/);
  });

  it('propagates replayDeletion when true; omits otherwise', () => {
    class On extends Composition {
      constructor() {
        super({ emitUsageEdges: true, usageOptions: { replayDeletion: true } });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'my-subnet' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
      }
    }
    const r = runComposition(
      On,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnet': SUBNET_OBSERVED_CLUSTER,
        },
      }),
    );
    const usage = findUsage(r.resources, 'ClusterUsage');
    expect(spec(usage!.document).replayDeletion).toBe(true);
  });

  it('skips external `of` by default; includes them when includeExternal is true', () => {
    class WithExternal extends Composition {
      constructor(opts: { includeExternal: boolean }) {
        super({
          emitUsageEdges: true,
          usageOptions: { includeExternal: opts.includeExternal },
        });
        const existing = Resource.fromExistingByName(
          this,
          'v1',
          'ConfigMap',
          'shared',
          'kube-system',
        );
        new Resource(this, 'consumer', {
          apiVersion: 'example.com/v1',
          kind: 'Consumer',
          metadata: { name: 'my-consumer' },
          spec: { value: (existing as any).data?.key },
        });
      }
    }
    const observedComposed = {
      'Composition/consumer': {
        apiVersion: 'example.com/v1',
        kind: 'Consumer',
        metadata: { name: 'my-consumer' },
        status: {},
      },
    };
    const observedRequired = {
      'v1/ConfigMap/kube-system/shared': {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'shared', namespace: 'kube-system' },
        data: { key: 'hello' },
      },
    };
    const skipped = runComposition(
      class extends WithExternal {
        constructor() {
          super({ includeExternal: false });
        }
      },
      input({ observedComposed, observedRequired }),
    );
    expect(findUsage(skipped.resources, 'ClusterUsage')).toBeUndefined();

    const included = runComposition(
      class extends WithExternal {
        constructor() {
          super({ includeExternal: true });
        }
      },
      input({ observedComposed, observedRequired }),
    );
    const usage = findUsage(included.resources, 'ClusterUsage');
    expect(usage).toBeDefined();
    expect(spec(usage!.document).of).toMatchObject({
      kind: 'ConfigMap',
      resourceRef: { name: 'shared' },
    });
  });

  it('skips edges where the dependent is external', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true, usageOptions: { includeExternal: true } });
        const existing = Resource.fromExistingByName(this, 'v1', 'ConfigMap', 'src');
        // External writes are not supported; we just want to assert no Usage
        // is synthesized when the dependent itself is external. Read its
        // value to register an edge originating from another resource.
        new Resource(this, 'sink', {
          apiVersion: 'example.com/v1',
          kind: 'Sink',
          metadata: { name: 'sink' },
          spec: { value: (existing as any).data?.key },
        });
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/sink': {
            apiVersion: 'example.com/v1',
            kind: 'Sink',
            metadata: { name: 'sink' },
            status: {},
          },
        },
        observedRequired: {
          'v1/ConfigMap/src': {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: 'src' },
            data: { key: 'v' },
          },
        },
      }),
    );
    // The sole dependent here is `sink`, which IS internal — so a usage exists.
    // But no usage should exist with `by` set to an external resource.
    for (const r of result.resources) {
      if (r.document.kind === 'Usage' || r.document.kind === 'ClusterUsage') {
        const by = spec(r.document).by as Record<string, unknown>;
        expect(by.kind).not.toBe('ConfigMap');
      }
    }
  });

  it('fans parent-level addDependency out to leaf Resources', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        const subnetA = new Resource(this, 'subnetA', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'sn-a' },
        });
        const subnetB = new Resource(this, 'subnetB', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'sn-b' },
        });
        subnetA.node.addDependency(vpc);
        subnetB.node.addDependency(vpc);
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnetA': {
            apiVersion: 'ec2.aws.crossplane.io/v1beta1',
            kind: 'Subnet',
            metadata: { name: 'sn-a' },
            status: {},
          },
          'Composition/subnetB': {
            apiVersion: 'ec2.aws.crossplane.io/v1beta1',
            kind: 'Subnet',
            metadata: { name: 'sn-b' },
            status: {},
          },
        },
      }),
    );
    const usages = result.resources.filter((r) => r.document.kind === 'ClusterUsage');
    expect(usages).toHaveLength(2);
    const names = usages
      .map((u) => {
        const by = spec(u.document).by as Record<string, unknown>;
        return (by.resourceRef as Record<string, unknown>).name as string;
      })
      .sort();
    expect(names).toEqual(['sn-a', 'sn-b']);
  });

  it('stamps the synthetic annotation on every emitted Usage', () => {
    class Comp extends Composition {
      constructor() {
        super({ emitUsageEdges: true });
        const vpc = new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'my-vpc' },
        });
        new Resource(this, 'subnet', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'Subnet',
          metadata: { name: 'sn' },
          spec: { vpcId: (vpc as any).status.atProvider.id },
        });
      }
    }
    const result = runComposition(
      Comp,
      input({
        observedComposed: {
          'Composition/vpc': VPC_OBSERVED,
          'Composition/subnet': {
            apiVersion: 'ec2.aws.crossplane.io/v1beta1',
            kind: 'Subnet',
            metadata: { name: 'sn' },
            status: {},
          },
        },
      }),
    );
    const usage = findUsage(result.resources, 'ClusterUsage');
    expect(annotations(usage!.document)?.[SYNTHETIC_ANNOTATION_KEY]).toBe(SYNTHETIC_USAGE_VALUE);
  });
});

describe('usageResourceName', () => {
  it('produces a sanitized deterministic generateName ending in a hyphen', () => {
    const a = usageResourceName('Composition/vpc', 'Composition/subnet');
    const b = usageResourceName('Composition/vpc', 'Composition/subnet');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+-$/);
    expect(a).toContain('--uses--');
  });

  it('appends a hash and leaves room for the k8s suffix for very long ids', () => {
    const long = 'x'.repeat(300);
    const name = usageResourceName(long, long);
    expect(name.length).toBeLessThanOrEqual(248);
    expect(name).toMatch(/-[0-9a-f]{8}-$/);
  });

  it('falls back to a placeholder when an id sanitizes to empty', () => {
    const name = usageResourceName('///', '...');
    expect(name).toBe('x--uses--x-');
  });
});

describe('buildUsageReason', () => {
  it('uses the field-list form when paths are present', () => {
    const reason = buildUsageReason(
      { apiVersion: 'v1', kind: 'Subnet', name: 'sn' },
      { apiVersion: 'v1', kind: 'VPC', name: 'vpc' },
      ['status.id'],
    );
    expect(reason).toBe('xplane: Subnet/sn needs VPC/vpc fields [status.id]');
  });

  it('uses the explicit-depends-on form when paths are empty', () => {
    const reason = buildUsageReason(
      { apiVersion: 'v1', kind: 'Subnet', name: 'sn' },
      { apiVersion: 'v1', kind: 'VPC', name: 'vpc' },
      [],
    );
    expect(reason).toBe('xplane: Subnet/sn explicitly depends on VPC/vpc');
  });
});
