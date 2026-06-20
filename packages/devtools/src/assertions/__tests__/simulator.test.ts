import type { CompositionContext } from '@xplane/core';
import {
  Composition,
  compositionStorage,
  DependencyGraph,
  EdgeCollector,
  Resource,
} from '@xplane/core';
import { describe, expect, it } from 'vitest';
import { Simulator } from '../index.js';

class VPCSubnetComposition extends Composition {
  constructor() {
    super();
    const vpc = new Resource(this, 'vpc', {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'VPC',
      metadata: { name: 'my-vpc' },
      spec: { forProvider: { region: 'us-east-1', cidrBlock: '10.0.0.0/16' } },
    });

    const subnet = new Resource(this, 'subnet', {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'Subnet',
      metadata: { name: 'my-subnet' },
      spec: { forProvider: { region: 'us-east-1', cidrBlock: '10.0.1.0/24' } },
    });

    // biome-ignore lint/suspicious/noExplicitAny: Resource proxy allows deep chaining at runtime
    (subnet as any).spec.forProvider.vpcId = (vpc as any).status.atProvider.vpcId;
  }
}

describe('Simulator.synthesize', () => {
  it('creates a simulator instance', () => {
    const sim = Simulator.synthesize(VPCSubnetComposition);
    expect(sim).toBeInstanceOf(Simulator);
  });
});

describe('Simulator.run', () => {
  it('blocks resources with unresolved dependencies', () => {
    const result = Simulator.synthesize(VPCSubnetComposition).withObserved([]).run();

    // VPC has no deps — emitted. Subnet depends on VPC — blocked.
    result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);
    // Blocked resources not in emitted
    result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 0);
  });

  it('emits resources when dependencies are satisfied', () => {
    const result = Simulator.synthesize(VPCSubnetComposition)
      .withObserved([
        {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          metadata: { name: 'vpc' },
          status: { atProvider: { vpcId: 'vpc-123' } },
        },
      ])
      .run();

    result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);
    result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 1);

    // Verify the resolved value was injected
    result.emitted.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
      forProvider: { vpcId: 'vpc-123' },
    });
  });

  it('injects XR data via synthesize options', () => {
    class XRComposition extends Composition {
      constructor() {
        super();
        new Resource(this, 'vpc', {
          apiVersion: 'ec2.aws.crossplane.io/v1beta1',
          kind: 'VPC',
          spec: {
            forProvider: {
              region: (this.xr as unknown as { spec: { region: string } }).spec.region,
            },
          },
        });
      }
    }

    const result = Simulator.synthesize(XRComposition, {
      xr: { spec: { region: 'eu-west-1' } },
    })
      .withObserved([])
      .run();

    result.emitted.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
      forProvider: { region: 'eu-west-1' },
    });
  });
});

describe('Simulator.fromComposition', () => {
  it('accepts a pre-built composition instance', () => {
    const graph = new DependencyGraph();
    const collector = new EdgeCollector();
    const ctx: CompositionContext = {
      xr: { spec: {}, status: {} },
      pipelineContext: new Map(),
      requiredResources: new Map(),
      observedComposed: new Map(),
      graph,
      collector,
    };
    const comp = compositionStorage.run(ctx, () => new VPCSubnetComposition());
    const sim = Simulator.fromComposition(comp);
    const result = sim.withObserved([]).run();

    result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);
  });
});
