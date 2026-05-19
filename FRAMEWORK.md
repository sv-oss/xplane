
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

### Architecture: Runtime / Framework Contract

xplane separates the **runtime** (`@xplane/function`) from the **framework** (`@xplane/core`) via a clean contract:

```
┌─────────────────────────┐       ┌─────────────────────────┐
│   @xplane/function      │       │   @xplane/core          │
│   (runtime)             │       │   (framework)           │
│                         │       │                         │
│ • Crossplane SDK I/O    │       │ • Composition class     │
│ • Request extraction    │ ───── │ • Resource tracking     │
│ • Response building     │       │ • Pipeline engine       │
│ • Loader dispatch       │       │ • runComposition()      │
└─────────────────────────┘       └─────────────────────────┘
            │                                  │
            ▼                                  ▼
    CompositionInput (plain data)     CompositionResult (plain data)
```

The boundary is defined by `CompositionModule`:

```ts
interface CompositionModule {
  run(input: CompositionInput): CompositionResult;
}
```

- **`CompositionInput`** — plain serializable data: `xr`, `pipelineContext`, `observedComposed`, `observedRequired`
- **`CompositionResult`** — plain serializable data: `resources`, `externalResources`, `xrStatus`, `diagnostics`

The runtime never touches framework internals (no WeakMaps, no AsyncLocalStorage, no proxy access). The framework's `runComposition()` is the single entry point that:
1. Sets up internal context (DependencyGraph, EdgeCollector, AsyncLocalStorage)
2. Instantiates the Composition class
3. Runs the pipeline (hydrate → resolve → sequence → diagnose → emit)
4. Evaluates readiness per resource
5. Returns a fully serializable `CompositionResult`

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
2. **A VM context is created** with a curated set of globals (like `console`, `JSON`, `Map`, etc.) and the core xplane classes (`Composition`, `Resource`, `Construct`, `runComposition`).
3. **Your code runs inside that context**, isolated from the host Node.js process. It cannot access the filesystem, network, or anything outside the sandbox unless explicitly provided.
4. **The sandbox looks for `exports.run`** — your bundle must export a `run` function with signature `(input: CompositionInput) => CompositionResult`. For thin bundles, use the sandbox-provided `runComposition` global to wrap your class.

#### How Context Flows (AsyncLocalStorage)

The xplane runtime uses Node.js `AsyncLocalStorage` to pass context (XR data, pipeline context, dependency graph) into your Composition constructor. The handler wraps instantiation in `compositionStorage.run(ctx, () => new YourComposition())`, so the `Composition` constructor automatically picks up the XR, pipeline context, and other runtime data.

This means:

- **If you rely on the sandbox globals** (don't bundle `@xplane/core`): your code uses the host's `Composition` and `Resource` classes directly. They share the same `compositionStorage` instance, so context flows naturally.
- **If you fully bundle `@xplane/core`**: your bundled copy has its own `AsyncLocalStorage` instance, but the sandbox evaluates your module with the host's `compositionStorage` already active — the `run()` wrapper around instantiation ensures context is available to any `AsyncLocalStorage` instance in the same async context.

#### Bundling Your Composition

**Option 1: Full bundle (recommended for production)**

Produce a fully self-contained bundle that includes `@xplane/core`. This decouples your composition from the function pod's runtime version:

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'cjs',
  platform: 'node',
  noExternal: [/@xplane\/core/, /constructs/],
});
```

**Option 2: Lightweight bundle with `vmGlobals()`**

Use the `vmGlobals()` plugin from `@xplane/devtools/bundler` to rewrite `@xplane/core` imports to reference the sandbox globals at build time. This produces smaller output but ties you to the function pod's `@xplane/core` version:

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

The `vmGlobals()` plugin is compatible with Rollup, Rolldown, and Vite. It works by intercepting imports:

- `import { Composition, Resource } from '@xplane/core'` → `const Composition = globalThis.Composition; ...`
- `import { Construct } from 'constructs'` → `const Construct = globalThis.Construct;`

> **Note:** The `vmGlobals()` approach produces smaller output but couples your composition to the pod's runtime version. For production deployments, prefer full bundles for version independence and reproducibility.

Your entry point just needs to export `run`:

```ts
import { runComposition } from '@xplane/core';
import { MyVpc } from './my-vpc.js';
export const run = (input) => runComposition(MyVpc, input);
```

The resulting CJS bundle assigns `exports.run = ...`, which is exactly what the sandbox expects.

#### What's Available in the Sandbox

If you do *not* fully bundle and instead rely on the VM context, these globals are provided:

| Category | Globals |
|----------|---------|
| xplane | `Composition`, `Resource`, `Construct`, `runComposition` |
| Standard JS | `JSON`, `Math`, `Date`, `Array`, `Object`, `Map`, `Set`, `RegExp`, `Promise` |
| Errors | `Error`, `TypeError`, `RangeError` |
| Text/Encoding | `TextEncoder`, `TextDecoder`, `Buffer`, `atob`, `btoa` |
| URLs | `URL`, `URLSearchParams`, `encodeURIComponent`, `decodeURIComponent` |
| Numbers | `parseInt`, `parseFloat`, `isNaN`, `isFinite` |
| Other | `console`, `require`, `exports` |

No filesystem, network, or child process access is available inside the sandbox. The code has a **5-second execution timeout** to prevent infinite loops.

#### Example: Using Sandbox Globals

When relying on the sandbox-injected globals, you don't need any `import` statements — `Composition`, `Resource`, `runComposition`, and other classes are already in scope:

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

exports.run = (input) => runComposition(MyConfig, input);
```

This code runs as-is inside the VM — no bundler, no build step. The sandbox provides `Composition`, `Resource`, `runComposition`, and `exports` automatically.

#### Summary

| Approach | Pros | Cons |
|----------|------|------|
| **Full bundle with `exports.run`** (recommended) | Self-contained, no version coupling, reproducible | Larger output, duplicates classes in memory |
| **Lightweight bundle with `vmGlobals()`** | Minimal size, uses host's runtime | Tied to the function pod's `@xplane/core` version |
| **Rely on sandbox globals** (no bundler) | Zero build step, smallest payload | Tied to pod version, no type safety |