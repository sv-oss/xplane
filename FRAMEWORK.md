
# Framework Usage

Work in progress - documentation for using the core framework to author compositions in TypeScript. This is a higher-level overview; see the source code and tests for more details and examples.

### Install in Your Project (for development)

Add xplane packages to your TypeScript project:

```bash
npm install @xplane/core
# or
pnpm add @xplane/core
```

### Generate Types

```bash
# From CRDs
npx @xplane/codegen generate-from crd \
  --uri https://doc.crds.dev/raw/github.com/kubernetes-sigs/karpenter@v1.5.0 \
  --output-dir src/generated

# From Crossplane CompositeResourceDefinitions (XRDs)
npx @xplane/codegen generate-from xrd \
  --uri ./path/to/xrd.yaml \
  --output-dir src/generated

# From Kubernetes core API schema version
npx @xplane/codegen generate-from k8s \
  --k8s-version v1.31.0 \
  --output-dir src/generated

# From a Crossplane provider OCI package
npx @xplane/codegen generate-from xpkg \
  --oci xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0 \
  --groups ec2.aws.upbound.io \
  --output-dir src/generated
```

---

### Author a Composition

A composition is a class that extends `Composition` and creates resources in its constructor:

```ts
import { Composition, Resource } from '@xplane/core';

class MyComposition extends Composition {
  constructor() {
    super();

    const vpc = new Resource(this, 'vpc', {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'VPC',
      spec: {
        forProvider: {
          region: this.xr.spec.region,
          cidrBlock: '10.0.0.0/16',
        },
      },
    });

    // Cross-resource dependencies are tracked automatically
    const subnet = new Resource(this, 'subnet', {
      apiVersion: 'ec2.aws.crossplane.io/v1beta1',
      kind: 'Subnet',
      spec: {
        forProvider: {
          region: this.xr.spec.region,
          vpcId: vpc.status.atProvider.vpcId, // creates a dependency edge
        },
      },
    });
  }
}
```

---

### Reading Existing Cluster Resources

Use `Resource.fromExistingByName()` to read data from resources that already exist in the cluster (not managed by your composition). This leverages Crossplane's **Required Resources** mechanism to fetch live cluster state.

```ts
import { Composition, Resource } from '@xplane/core';

class MyComposition extends Composition {
  constructor() {
    super();

    // Read an existing GCP Project resource from the cluster
    const project = Resource.fromExistingByName(
      this,
      'gcp.upbound.io/v1beta1',
      'Project',
      'shared-project',
    );

    // Use fields from the existing resource — creates a dependency edge
    new Resource(this, 'bucket', {
      apiVersion: 'storage.gcp.upbound.io/v1beta1',
      kind: 'Bucket',
      spec: {
        forProvider: {
          project: project.status.atProvider.projectId,
        },
      },
    });
  }
}
```

#### Available Proxies

Each existing resource provides three tracked proxies:

| Proxy | Description | Example |
|-------|-------------|---------|
| `.status` | Observed status fields | `project.status.atProvider.projectId` |
| `.spec` | Observed spec fields | `project.spec.forProvider.region` |
| `.root` | Arbitrary top-level fields (beyond `spec`/`status`) | `secret.root.data.password` |

The `.root` proxy is useful for non-standard resources like Secrets or ConfigMaps that store data outside `spec`/`status`:

```ts
// Read a Secret's data field
const dbSecret = Resource.fromExistingByName(this, 'v1', 'Secret', 'db-creds', 'default');

new Resource(this, 'connection', {
  apiVersion: 'example.io/v1',
  kind: 'Connection',
  spec: {
    password: dbSecret.root.data.password,
  },
});
```

#### Namespaced Resources

Pass a namespace as the fifth argument:

```ts
const secret = Resource.fromExistingByName(this, 'v1', 'Secret', 'my-secret', 'my-namespace');
```

#### Generated Types

When using `@xplane/codegen`, generated resource classes include a typed `fromExistingByName` static method:

```ts
import { Project } from './generated/gcp.upbound.io/v1beta1/project.js';

const project = Project.fromExistingByName(this, 'shared-project');
```

#### How It Works

1. On the first reconciliation, xplane emits a `requireResource` requirement telling Crossplane to fetch the resource by name.
2. Crossplane fetches the resource and provides it on the next function call.
3. On subsequent calls, the existing resource's observed state is populated, dependency edges resolve, and dependent resources unblock.
4. If the resource cannot be found after multiple iterations, a `MissingRequiredResource` condition is set on the XR.