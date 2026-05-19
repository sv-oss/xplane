
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

---

### VM Sandbox & Bundling

When xplane runs your composition inside the Crossplane Function pod, it executes your code in a **Node.js VM sandbox** — an isolated JavaScript environment separate from the host process. This section explains how it works and how you can fully bundle your compositions without relying on the sandbox's built-in globals.

#### How the Sandbox Works

1. **Your composition code is loaded as a string** — either inline (embedded in the Crossplane input) or fetched from a git repository.
2. **A VM context is created** with a curated set of globals (like `console`, `JSON`, `Map`, etc.) and the core xplane classes (`Composition`, `Resource`, `Construct`).
3. **Your code runs inside that context**, isolated from the host Node.js process. It cannot access the filesystem, network, or anything outside the sandbox unless explicitly provided.
4. **The sandbox looks for `exports.composition`** — your bundle must export your composition class under that name, similar to how a Lambda exports `index.handler`.

#### The `globalThis` Bridge

When you bundle your composition, your bundler (e.g. tsdown/rolldown) includes its own copy of `@xplane/core` in the output. This means the `Composition` class in your bundle is a *different instance* than the one the sandbox host uses to pass in the XR data.

To solve this, xplane exposes two well-known properties on `globalThis` inside the VM:

- `__xplane_pendingXR` — the observed composite resource (XR) data
- `__xplane_pendingEnvironment` — the environment config data

When your bundled `Composition` constructor runs, it checks both the static class property (`Composition._pendingXR`) and `globalThis.__xplane_pendingXR`. This means:

- **If you rely on the sandbox globals** (don't bundle `@xplane/core`): your code uses the host's `Composition` class directly, and data flows through the static property.
- **If you fully bundle `@xplane/core`**: your bundled copy reads the XR/environment data from `globalThis`, so everything still works without any extra configuration.

#### Fully Bundled Compositions

You can produce a single self-contained `.js` file that has zero reliance on VM-injected globals for `@xplane/core`. Your bundler resolves all imports at build time, and the `globalThis` bridge ensures your bundled `Composition` receives the XR and environment data at runtime.

A minimal build config (using tsdown):

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'cjs',
  platform: 'node',
  treeshake: true,
});
```

#### Lightweight Bundled Compositions

If you want to keep your bundle small while still writing standard `import` statements, use the `vmGlobals()` plugin from `@xplane/devtools/bundler`. It rewrites `@xplane/core` and `constructs` imports to reference the sandbox globals at build time — so your output doesn't include a copy of `@xplane/core`.

```ts
import { defineConfig } from 'tsdown';
import { vmGlobals } from '@xplane/devtools/bundler';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'cjs',
  platform: 'node',
  plugins: [vmGlobals()],
});
```

The plugin is compatible with Rollup, Rolldown, and Vite. It works by intercepting imports:

- `import { Composition, Resource } from '@xplane/core'` → `const Composition = globalThis.Composition; ...`
- `import { Construct } from 'constructs'` → `const Construct = globalThis.Construct;`

#### Full Bundle vs Lightweight Bundle

| | Full bundle (`noExternal`) | Lightweight bundle (`vmGlobals()`) |
|--|---|---|
| **Output size** | Larger — includes `@xplane/core` and `constructs` source | Minimal — only your composition code |
| **Version control** | Your bundle pins the exact `@xplane/core` version it was built with | Uses whichever version is in the function pod at runtime |
| **Compatibility** | Always works — immune to breaking changes in the function pod | Could break if the pod's `@xplane/core` changes its API |
| **Recommended for** | Production, CI/CD pipelines, long-lived compositions | Rapid iteration, development, or when bundle size matters |

**Recommendation:** Use a full bundle for production workloads where stability matters. Use a lightweight bundle during development when you want fast rebuilds and trust the function pod is running a compatible version.

Your entry point just needs to re-export the class:

```ts
import { MyVpc } from './my-vpc.js';
export { MyVpc as composition };
```

The resulting CJS bundle assigns `exports.composition = MyVpc`, which is exactly what the sandbox expects.

#### What's Available in the Sandbox

If you do *not* fully bundle and instead rely on the VM context, these globals are provided:

| Category | Globals |
|----------|---------|
| xplane | `Composition`, `Resource`, `Construct` |
| Standard JS | `JSON`, `Math`, `Date`, `Array`, `Object`, `Map`, `Set`, `RegExp`, `Promise` |
| Errors | `Error`, `TypeError`, `RangeError` |
| Text/Encoding | `TextEncoder`, `TextDecoder`, `Buffer`, `atob`, `btoa` |
| URLs | `URL`, `URLSearchParams`, `encodeURIComponent`, `decodeURIComponent` |
| Numbers | `parseInt`, `parseFloat`, `isNaN`, `isFinite` |
| Other | `console`, `require`, `exports` |

No filesystem, network, or child process access is available inside the sandbox. The code has a **5-second execution timeout** to prevent infinite loops.

#### Example: Using Sandbox Globals

When relying on the sandbox-injected globals, you don't need any `import` statements — `Composition`, `Resource`, and other classes are already in scope. Here's a minimal composition that creates a ConfigMap:

```js
class MyConfig extends Composition {
  constructor() {
    super();

    new Resource(this, 'config', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        namespace: this.xr.spec.namespace,
      },
      data: {
        appName: this.xr.spec.appName,
        environment: this.xr.spec.environment ?? 'production',
      },
    });
  }
}

exports.composition = MyConfig;
```

This code runs as-is inside the VM — no bundler, no build step. The sandbox provides `Composition`, `Resource`, and `exports` automatically.

#### Summary

| Approach | Pros | Cons |
|----------|------|------|
| **Fully bundled** (recommended) | Self-contained, version-locked, no surprises | Slightly larger payload |
| **Rely on sandbox globals** | Smaller code payload | Tied to the function pod's `@xplane/core` version |