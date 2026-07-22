# Quickstart: Authoring a Composition

This guide walks you through creating a Crossplane composition function with xplane from scratch.

## 1. Create Your Project

```bash
mkdir my-composition && cd my-composition
pnpm init
pnpm add @xplane/core
pnpm add -D @xplane/devtools @xplane/codegen typescript tsdown vitest
```

## 2. Define Your XRD

Create `apis/vpcwithsubnet.yaml` — this is the Crossplane CompositeResourceDefinition that defines your claim's API:

```yaml
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: vpcwithsubnet.network.example.io
spec:
  group: network.example.io
  names:
    kind: VpcWithSubnet
    plural: vpcwithsubnets
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                region:
                  type: string
                  description: AWS region for all resources
                cidrBlock:
                  type: string
                  description: CIDR block for the VPC
                  default: "10.0.0.0/16"
              required:
                - region
            status:
              type: object
              properties:
                vpcId:
                  type: string
                  description: The ID of the created VPC
                subnetId:
                  type: string
                  description: The ID of the created Subnet
```

## 3. Generate Types

Generate TypeScript types for the resources you'll compose:

```bash
# Generate types from your XRD
pnpm exec xplane-codegen generate-types-from xrd \
  --uri ./apis/vpcwithsubnet.yaml \
  --output-dir src/generated

# Generate types from a Crossplane provider OCI package
pnpm exec xplane-codegen generate-types-from xpkg \
  --oci xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0 \
  --groups ec2.aws.m.upbound.io \
  --output-dir src/generated
```

## 4. Write Your Composition

Create `src/vpcwithsubnet.ts`:

```ts
import { Composition } from '@xplane/core';
import { Subnet, VPC  } from './generated/ec2.aws.m.upbound.io.v1beta1';
import type { VpcWithSubnetSpec, VpcWithSubnetStatus } from './generated/network.example.io.v1alpha1'

export class VpcWithSubnet extends Composition<VpcWithSubnetSpec, VpcWithSubnetStatus> {
  constructor() {
    super();

    // Read XR claim data via this.xr
    const region = this.xr.spec.region;
    const cidrBlock = this.xr.spec.cidrBlock;

    // Create a VPC — apiVersion and kind are set automatically
    const vpc = new VPC(this, 'vpc', {
      spec: {
        forProvider: {
          region,
          cidrBlock,
          enableDnsSupport: true,
          enableDnsHostnames: true,
        },
      },
    });

    // Create a Subnet — depends on VPC
    const subnet = new Subnet(this, 'subnet', {
      spec: {
        forProvider: {
          region,
          cidrBlock: '10.0.1.0/24',
          // This assignment creates a dependency edge automatically.
          // The subnet won't be emitted until the VPC's vpcId is observed.
          vpcId: vpc.status.atProvider?.id,
        },
      },
    });

    // Write back to the XR's status
    this.xr.status.vpcId = vpc.status.atProvider?.id;
    this.xr.status.subnetId = subnet.status.atProvider?.id;
  }
}
```

**Key concepts:**
- Generated classes like `VPC` and `Subnet` provide typed `spec` and `status` — no need to specify `apiVersion`/`kind`
- `this.xr` — read the composite resource (XR) claim data
- `vpc.status.atProvider.id` — reading another resource's status creates a **dependency edge**
- Resources with unresolved dependencies are automatically held back until their dependencies are observed

> **Without codegen:** You can always use the untyped `Resource` class directly:
> ```ts
> import { Resource } from '@xplane/core';
> new Resource(this, 'vpc', { apiVersion: 'ec2.aws.upbound.io/v1beta1', kind: 'VPC', spec: { ... } });
> ```

## 5. Create the Entry Point

Create `src/index.ts`:

```ts
import { type CompositionInput, runComposition } from '@xplane/core';
import { VpcWithSubnet } from './vpc.js';

export const run = (input: CompositionInput) => runComposition(VpcWithSubnet, input);
```

## 6. Bundle It

Create `tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'cjs',
  platform: 'node',
  deps: {
    alwaysBundle: [/@xplane\/core/, /constructs/],
  },
});
```

Build:

```bash
pnpm exec tsdown
```

This produces `dist/index.js` — a self-contained bundle ready for the xplane function runtime.

## 7. Write Tests

Create `src/vpcwithsubnet.test.ts`:

```ts
import { Match, Simulator, Template } from '@xplane/devtools/assertions';
import { describe, it } from 'vitest';
import { VpcWithSubnet } from './vpcwithsubnet.js';

describe('VpcWithSubnet', () => {
  const xr = { spec: { region: 'us-east-1', cidrBlock: '10.0.0.0/16' } };

  describe('declaration', () => {
    const template = Template.synthesize(VpcWithSubnet, { xr });

    it('creates a VPC and a Subnet', () => {
      template.resourceCountIs('ec2.aws.m.upbound.io/v1beta1', 'VPC', 1);
      template.resourceCountIs('ec2.aws.m.upbound.io/v1beta1', 'Subnet', 1);
    });

    it('VPC uses the XR region and CIDR', () => {
      template.hasResourceSpec('ec2.aws.m.upbound.io/v1beta1', 'VPC', {
        forProvider: { region: 'us-east-1', cidrBlock: '10.0.0.0/16' },
      });
    });

    it('subnet has a pending vpcId (unresolved dependency)', () => {
      template.hasResourceSpec('ec2.aws.m.upbound.io/v1beta1', 'Subnet', {
        forProvider: { vpcId: Match.pending() },
      });
    });
  });

  describe('sequencing', () => {
    it('subnet is blocked without VPC observed state', () => {
      const result = Simulator.synthesize(VpcWithSubnet, { xr })
        .withObserved([])
        .run();

      result.emitted.resourceCountIs('ec2.aws.m.upbound.io/v1beta1', 'VPC', 1);
      result.blocked.resourceCountIs('ec2.aws.m.upbound.io/v1beta1', 'Subnet', 1);
    });

    it('subnet is emitted once VPC status is available', () => {
      const result = Simulator.synthesize(VpcWithSubnet, { xr })
        .withObserved([
          {
            apiVersion: 'ec2.aws.m.upbound.io/v1beta1',
            kind: 'VPC',
            metadata: { name: 'vpc' },
            status: { atProvider: { id: 'vpc-abc123' } },
          },
        ])
        .run();

      result.emitted.resourceCountIs('ec2.aws.m.upbound.io/v1beta1', 'Subnet', 1);
      result.emitted.hasResourceSpec('ec2.aws.m.upbound.io/v1beta1', 'Subnet', {
        forProvider: { vpcId: 'vpc-abc123' },
      });
    });
  });
});
```

Run tests:

```bash
pnpm exec vitest run
```

## 8. Deploy

### Using the Git Loader

Push your bundled code to a git repository, then reference it in a Crossplane Composition:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
spec:
  compositeTypeRef:
    apiVersion: network.example.io/v1alpha1
    kind: XNetwork
  pipeline:
    - step: render
      functionRef:
        name: xplane-function
      input:
        apiVersion: inputs.xplane.io/v1alpha1
        kind: Git
        spec:
          url: https://github.com/your-org/compositions
          path: vpc/dist
          ref: main
          tokenPath: /var/secrets/git-token
          provider: github
```

### Using the Inline Loader

For simple compositions, embed the code directly. The runtime provides `Composition`, `Resource`, and `runComposition` as globals in the inline sandbox — no imports needed. Note that inline compositions run against the `@xplane/core` version installed in the function runtime, so you don't control the framework version.

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
spec:
  compositeTypeRef:
    apiVersion: network.example.io/v1alpha1
    kind: XNetwork
  pipeline:
    - step: render
      functionRef:
        name: xplane-function
      input:
        apiVersion: inputs.xplane.io/v1alpha1
        kind: Inline
        spec:
          code: |
            class VpcWithSubnet extends Composition {
              constructor() {
                super();
                new Resource(this, 'vpc', {
                  apiVersion: 'ec2.aws.upbound.io/v1beta1',
                  kind: 'VPC',
                  spec: { forProvider: { region: this.xr.spec.region, cidrBlock: '10.0.0.0/16' } },
                });
              }
            }
            exports.run = (input) => runComposition(VpcWithSubnet, input);
```

---

## Reading Existing Cluster Resources

Use the generated `fromExistingByName()` static method to read resources that already exist in the cluster:

```ts
import { Composition } from '@xplane/core';
import { Project } from './generated/gcp.upbound.io/v1beta1/project.js';
import { Bucket } from './generated/storage.gcp.upbound.io/v1beta1/bucket.js';

class BucketComposition extends Composition {
  constructor() {
    super();

    // Fetch a shared project from the cluster by name
    const project = Project.fromExistingByName(this, 'shared-project');

    // Use its status — creates a dependency edge
    new Bucket(this, 'bucket', {
      spec: {
        forProvider: {
          project: project.status.atProvider.projectId,
        },
      },
    });
  }
}
```

Without generated types, you can use `Resource.fromExistingByName()` directly:

```ts
const project = Resource.fromExistingByName(this, 'gcp.upbound.io/v1beta1', 'Project', 'shared-project');
```

This uses Crossplane's **Required Resources** mechanism — the runtime tells Crossplane to fetch the resource, and on subsequent reconcile loops the data becomes available.

---

## Resource Configuration

### Auto-Ready (default: enabled)

Resources automatically report `ready: true` when their observed status includes a `True` condition with type `Ready` or `Synced`. Disable per-resource:

```ts
const vpc = new VPC(this, 'vpc', { spec: { forProvider: { ... } } });
vpc.resource.autoReady = false; // always report ready
```

### Custom Ready Checks

```ts
const db = new RDSInstance(this, 'database', { spec: { forProvider: { ... } } });
db.resource.addReadyCheck((observed) => {
  return observed?.status?.atProvider?.state === 'available';
});
```

---

## Next Steps

- [FRAMEWORK.md](FRAMEWORK.md) — Full framework reference (architecture, VM sandbox, bundling options)
- [TESTING.md](TESTING.md) — Complete testing guide (Template, Match, Simulator APIs)
- [README.md](README.md) — Project overview and function runtime deployment
