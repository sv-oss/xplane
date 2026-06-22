# Testing Compositions with `@xplane/devtools`

The `@xplane/devtools` package provides an assertions toolkit for unit testing your xplane compositions, inspired by [aws-cdk-lib/assertions](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.assertions-readme.html).

## Installation

```bash
pnpm add -D @xplane/devtools
# or
npm install --save-dev @xplane/devtools
```

## Import

```ts
import { Template, Match, Simulator } from '@xplane/devtools/assertions';
```

---

## Template — Declaration-Level Testing

`Template` lets you assert what resources a composition declares, without simulating any observed state or sequencing. It includes **all** declared resources — both those that would be emitted immediately and those that are blocked waiting on dependencies. Unresolved cross-resource references are represented as `PendingValue` objects that you can match with `Match.pending()`.

### Creating a Template

```ts
import { Template } from '@xplane/devtools/assertions';
import { MyComposition } from '../src/my-composition.js';

// Synthesize with XR data injected automatically
const template = Template.synthesize(MyComposition, {
  xr: {
    metadata: { name: 'my-claim', namespace: 'default' },
    spec: { region: 'us-east-1', cidrBlock: '10.0.0.0/16' },
  },
});
```

You can also inject environment data:

```ts
const template = Template.synthesize(MyComposition, {
  xr: { spec: { region: 'us-east-1' } },
  environment: { awsAccountId: '123456789012' },
});
```

Or use an already-instantiated composition:

```ts
import { compositionStorage, DependencyGraph, EdgeCollector } from '@xplane/core';

const ctx = {
  xr: { spec: { region: 'us-east-1' }, status: {} },
  pipelineContext: new Map(),
  requiredResources: new Map(),
  graph: new DependencyGraph(),
  collector: new EdgeCollector(),
  observedComposed: new Map(),
};

const comp = compositionStorage.run(ctx, () => new MyComposition());
const template = Template.fromComposition(comp);
```

### Counting Resources

```ts
// Assert exactly 1 VPC is declared
template.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);

// Assert no Secrets are declared
template.resourceCountIs('v1', 'Secret', 0);
```

### Asserting Resource Properties

```ts
// Assert at least one VPC exists with these spec properties (deep-partial match)
template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  forProvider: {
    region: 'us-east-1',
    cidrBlock: '10.0.0.0/16',
  },
});

// Assert metadata
template.hasResourceMetadata('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  labels: { team: 'platform' },
});

// Assert entire resource structure (still deep-partial by default)
template.hasResource('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  metadata: { name: Match.stringLikeRegexp('.*vpc.*') },
  spec: { forProvider: { region: 'us-east-1' } },
});
```

### Asserting All Resources of a Type

```ts
// Every Subnet must be in us-east-1
template.allResources('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
  spec: { forProvider: { region: 'us-east-1' } },
});
```

### Finding Resources (No Throw)

```ts
// Returns matching resources — never throws
const subnets = template.findResources('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
  spec: { forProvider: { availabilityZone: 'us-east-1a' } },
});
expect(subnets).toHaveLength(1);
```

### Snapshot Testing

```ts
expect(template.toJSON()).toMatchSnapshot();
```

`toJSON()` returns a deep-cloned `KubernetesResource[]` array suitable for Vitest/Jest snapshot testing.

---

## Match — Composable Matchers

All assertion methods accept matcher instances anywhere in the expected object tree. By default, assertions use **deep-partial matching** (the actual value can be a superset of the expected pattern).

### Object Matchers

```ts
// Deep-partial: actual may have additional keys at any level
template.hasResourceSpec('v1', 'ConfigMap', {
  data: Match.objectLike({ importantKey: 'value' }),
});

// Exact: actual must have exactly these keys and values
template.hasResourceSpec('v1', 'ConfigMap', {
  data: Match.objectEquals({ key1: 'a', key2: 'b' }),
});
```

### Array Matchers

```ts
// Subset (in order): actual array must contain these items in sequence
template.hasResourceSpec('v1', 'ConfigMap', {
  data: { items: Match.arrayWith(['required-item']) },
});

// Exact: actual array must equal this exactly
template.hasResourceSpec('v1', 'ConfigMap', {
  data: { items: Match.arrayEquals(['a', 'b', 'c']) },
});
```

### String Matchers

```ts
template.hasResource('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  metadata: { name: Match.stringLikeRegexp('prod-vpc-.*') },
});

// Also accepts RegExp instances
template.hasResourceMetadata('v1', 'ConfigMap', {
  namespace: Match.stringLikeRegexp(/^kube-/),
});
```

### Presence and Absence

```ts
// Assert a field exists with any non-null/undefined value
template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  forProvider: { region: Match.anyValue() },
});

// Assert a field is NOT present
template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  forProvider: { deletionPolicy: Match.absent() },
});
```

### Not Matcher

```ts
// Assert the value does NOT match the given pattern
template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
  forProvider: { region: Match.not('us-west-2') },
});
```

### Pending Matcher

```ts
// Assert a field is an unresolved dependency (any pending value)
template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
  forProvider: { vpcId: Match.pending() },
});

// Assert a specific source resource and path
template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
  forProvider: {
    vpcId: Match.pending({
      source: 'Composition/vpc',
      path: 'status.atProvider.vpcId',
    }),
  },
});
```

### Composing Matchers

Matchers compose naturally within object literals:

```ts
template.hasResource('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
  metadata: {
    name: Match.stringLikeRegexp('subnet-.*'),
    labels: Match.objectLike({ env: 'prod' }),
  },
  spec: {
    forProvider: {
      cidrBlock: Match.anyValue(),
      tags: Match.arrayWith([
        Match.objectLike({ key: 'Team', value: 'platform' }),
      ]),
    },
  },
});
```

---

## Simulator — Sequencing & Edge Resolution Testing

`Simulator` extends `Template` testing by simulating the full runtime pipeline: injecting observed state, resolving dependency edges, and computing which resources are emitted vs blocked.

### Basic Simulation

```ts
import { Simulator } from '@xplane/devtools/assertions';

const result = Simulator.synthesize(MyComposition, {
  xr: { spec: { region: 'us-east-1' } },
})
  .withObserved([
    // Simulate that the VPC already exists in the cluster
    {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'VPC',
      metadata: { name: 'vpc' }, // must match the resource's construct path
      status: { atProvider: { vpcId: 'vpc-abc123' } },
    },
  ])
  .run();
```

### Asserting Emitted vs Blocked Resources

```ts
// VPC is emitted (no deps)
result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);

// Subnet is emitted because its VPC dependency is satisfied
result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 1);

// Verify the resolved edge value was injected into the subnet's spec
result.emitted.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
  forProvider: { vpcId: 'vpc-abc123' },
});
```

### Testing Blocked Resources

```ts
// Without observed state, dependent resources are blocked
const result = Simulator.synthesize(MyComposition, {
  xr: { spec: { region: 'us-east-1' } },
})
  .withObserved([]) // No cluster state yet
  .run();

// VPC has no dependencies — always emitted
result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);

// Subnet depends on VPC status — blocked until VPC is observed
result.blocked.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 1);
```

### Simulation with `fromComposition`

```ts
import { compositionStorage, DependencyGraph, EdgeCollector } from '@xplane/core';

const ctx = {
  xr: { spec: { region: 'us-east-1' }, status: {} },
  pipelineContext: new Map(),
  requiredResources: new Map(),
  graph: new DependencyGraph(),
  collector: new EdgeCollector(),
  observedComposed: new Map(),
};

const comp = compositionStorage.run(ctx, () => new MyComposition());

const result = Simulator.fromComposition(comp)
  .withObserved([...])
  .run();
```

### Testing Existing Resources with `withExisting`

When your composition uses `Resource.fromExistingByName()` to read cluster resources, use `.withExisting()` in the simulator to provide their data:

```ts
import { Simulator } from '@xplane/devtools/assertions';

class ProjectBucketComposition extends Composition {
  constructor() {
    super();
    const project = Resource.fromExistingByName(
      this, 'gcp.upbound.io/v1beta1', 'Project', 'shared-project',
    );

    new Resource(this, 'bucket', {
      apiVersion: 'storage.gcp.upbound.io/v1beta1',
      kind: 'Bucket',
      spec: { forProvider: { project: project.status.atProvider.projectId } },
    });
  }
}

it('resolves fields from an existing resource', () => {
  const result = Simulator.synthesize(ProjectBucketComposition, {
    xr: { spec: {} },
  })
    .withExisting({
      'gcp.upbound.io/v1beta1/Project/shared-project': {
        apiVersion: 'gcp.upbound.io/v1beta1',
        kind: 'Project',
        metadata: { name: 'shared-project' },
        status: { atProvider: { projectId: 'my-gcp-project-123' } },
      },
    })
    .run();

  // Bucket is emitted with the resolved project ID
  result.emitted.resourceCountIs('storage.gcp.upbound.io/v1beta1', 'Bucket', 1);
  result.emitted.hasResourceSpec('storage.gcp.upbound.io/v1beta1', 'Bucket', {
    forProvider: { project: 'my-gcp-project-123' },
  });
});

it('blocks when existing resource is unavailable', () => {
  const result = Simulator.synthesize(ProjectBucketComposition, {
    xr: { spec: {} },
  })
    // No .withExisting() — resource not available
    .run();

  result.blocked.resourceCountIs('storage.gcp.upbound.io/v1beta1', 'Bucket', 1);
});
```

The keys in the `withExisting` record follow the format `apiVersion/Kind/name` (or `apiVersion/Kind/name/namespace` for namespaced resources). This matches the ref key shown in `composition.existingResources`.

#### Asserting Conditions

The simulation result includes `conditions` for error states:

```ts
it('reports missing required resource condition', () => {
  const result = Simulator.synthesize(ProjectBucketComposition, {
    xr: { spec: {} },
  })
    .run();

  expect(result.conditions).toContainEqual(
    expect.objectContaining({
      type: 'Ready',
      status: 'False',
      reason: 'MissingRequiredResource',
    }),
  );
});
```

---

## Full Example

```ts
import { describe, expect, it } from 'vitest';
import { Composition, Resource } from '@xplane/core';
import { Template, Match, Simulator } from '@xplane/devtools/assertions';

class NetworkComposition extends Composition {
  constructor() {
    super();
    const vpc = new Resource(this, 'vpc', {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'VPC',
      metadata: { name: 'my-vpc' },
      spec: {
        forProvider: {
          region: this.xr.spec.region,
          cidrBlock: '10.0.0.0/16',
        },
      },
    });

    const subnet = new Resource(this, 'subnet', {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'Subnet',
      metadata: { name: 'my-subnet' },
      spec: {
        forProvider: {
          region: this.xr.spec.region,
          cidrBlock: '10.0.1.0/24',
        },
      },
    });

    // Creates a dependency edge: subnet depends on vpc
    subnet.spec.forProvider.vpcId = vpc.status.atProvider.vpcId;
  }
}

describe('NetworkComposition', () => {
  describe('declaration tests', () => {
    const template = Template.synthesize(NetworkComposition, {
      xr: { spec: { region: 'us-east-1' } },
    });

    it('creates a VPC and a Subnet', () => {
      template.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);
      template.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 1);
    });

    it('VPC uses the XR region', () => {
      template.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'VPC', {
        forProvider: { region: 'us-east-1' },
      });
    });

    it('all resources are in the same region', () => {
      template.allResources('ec2.aws.crossplane.io/v1beta1', 'VPC', {
        spec: { forProvider: { region: 'us-east-1' } },
      });
      template.allResources('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
        spec: { forProvider: { region: 'us-east-1' } },
      });
    });

    it('matches snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('sequencing tests', () => {
    it('subnet is blocked without VPC observed state', () => {
      const result = Simulator.synthesize(NetworkComposition, {
        xr: { spec: { region: 'us-east-1' } },
      })
        .withObserved([])
        .run();

      result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'VPC', 1);
      result.blocked.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 1);
    });

    it('subnet is emitted with resolved vpcId when VPC is observed', () => {
      const result = Simulator.synthesize(NetworkComposition, {
        xr: { spec: { region: 'us-east-1' } },
      })
        .withObserved([
          {
            apiVersion: 'ec2.aws.crossplane.io/v1beta1',
            kind: 'VPC',
            metadata: { name: 'vpc' },
            status: { atProvider: { vpcId: 'vpc-real-123' } },
          },
        ])
        .run();

      result.emitted.resourceCountIs('ec2.aws.crossplane.io/v1beta1', 'Subnet', 1);
      result.emitted.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
        forProvider: { vpcId: 'vpc-real-123' },
      });
    });
  });
});
```

---

## API Reference

### `Template`

| Method | Description |
|--------|-------------|
| `Template.synthesize(Ctor, options?)` | Inject XR/environment, instantiate composition, return Template |
| `Template.fromComposition(comp)` | Build from existing Composition instance |
| `Template.fromResources(resources)` | Build from raw KubernetesResource array |
| `resourceCountIs(apiVersion, kind, count)` | Assert resource count |
| `hasResource(apiVersion, kind, props?)` | Assert at least one resource matches |
| `hasResourceSpec(apiVersion, kind, specProps)` | Assert at least one resource's spec matches |
| `hasResourceMetadata(apiVersion, kind, metaProps)` | Assert at least one resource's metadata matches |
| `allResources(apiVersion, kind, props)` | Assert ALL resources of that type match |
| `findResources(apiVersion, kind, props?)` | Return matching resources (never throws) |
| `toJSON()` | Return deep-cloned resource array for snapshots |

### `Match`

| Method | Description |
|--------|-------------|
| `Match.objectLike(pattern)` | Deep-partial object match |
| `Match.objectEquals(pattern)` | Exact object match |
| `Match.arrayWith(items)` | Array subset match (in order) |
| `Match.arrayEquals(items)` | Exact array match |
| `Match.stringLikeRegexp(pattern)` | String regex match |
| `Match.absent()` | Assert value is undefined |
| `Match.anyValue()` | Assert any non-null/undefined value |
| `Match.not(pattern)` | Invert a match |
| `Match.pending(expected?)` | Assert value is an unresolved dependency. Optional `{ source?, path? }` for specifics |

### `Simulator`

| Method | Description |
|--------|-------------|
| `Simulator.synthesize(Ctor, options?)` | Inject XR/environment, instantiate, return Simulator |
| `Simulator.fromComposition(comp)` | Build from existing Composition instance |
| `withObserved(resources)` | Provide observed cluster state for composed resources |
| `withExisting(resources)` | Provide existing cluster resource data (keyed by ref key) |
| `run()` | Run simulation, returns `{ emitted: Template, blocked: Template, conditions }` |

### `SynthesizeOptions`

```ts
interface SynthesizeOptions {
  xr?: Record<string, unknown>;
  environment?: Record<string, unknown>;
}
```
