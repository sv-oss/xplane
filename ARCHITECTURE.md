# Architecture

This document describes the internal architecture of xplane — a TypeScript framework for authoring Crossplane composition functions.

---

## Package Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         @xplane/function                                │
│  Runtime: gRPC server, loaders (git/inline), VM sandbox, handler        │
│  Depends on: @xplane/core, @crossplane-org/function-sdk-typescript      │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ uses CompositionInput/CompositionResult
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           @xplane/core                                  │
│  Framework: Composition, Resource, proxy system, pipeline, contract      │
│  Zero runtime dependencies (except `constructs`)                        │
└─────────────────────────────────────────────────────────────────────────┘
                                 ▲
                                 │ uses for testing
┌─────────────────────────────────────────────────────────────────────────┐
│                         @xplane/devtools                                │
│  Testing: Template, Simulator, Match assertions, bundler plugin         │
│  Depends on: @xplane/core                                               │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         @xplane/codegen                                 │
│  Code generation: XRD → types, OCI xpkg → types, CRD → types           │
│  Standalone — no dependency on core or function                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Dependency Rules

- `@xplane/core` has no knowledge of Crossplane SDK types or gRPC — it operates on plain data
- `@xplane/function` is the only package that touches the Crossplane Function SDK
- `@xplane/devtools` depends only on `@xplane/core` — never on `@xplane/function`
- `@xplane/codegen` is fully independent — it generates types that consumers use with core

---

## The Contract Boundary

The runtime (`@xplane/function`) and framework (`@xplane/core`) communicate through a strict plain-data contract:

```
Runtime                          Contract                         Framework
─────────                        ────────                         ─────────
RunFunctionRequest  ──extract──▶  CompositionInput  ──────────▶  runComposition()
                                                                       │
RunFunctionResponse ◀──map─────  CompositionResult  ◀───────────────-──┘
```

**`CompositionInput`** — plain Records:
- `xr` — observed XR (spec, status, metadata)
- `pipelineContext` — Crossplane function context keys
- `observedComposed` — observed composed resources keyed by name
- `observedRequired` — observed existing/required resources keyed by refKey

**`CompositionResult`** — plain serializable data:
- `resources` — desired resources with documents, names, readiness
- `externalResources` — requests to fetch cluster resources
- `xrStatus` — desired XR status patches
- `diagnostics` — structured reports for blocked resources

**`CompositionModule`** — the shape of what a bundle exports:
```ts
interface CompositionModule {
  run(input: CompositionInput): CompositionResult;
}
```

No class instances, WeakMaps, or framework internals cross this boundary.

---

## Core Internals (`@xplane/core`)

### Construct Tree

Built on the `constructs` library. Every `Composition` is a root `Construct`; every `Resource` is a child construct:

```
Composition (root)
├── Resource "vpc"
├── Resource "subnet"
└── Resource "security-group"
```

The tree provides: parent/child relationships, unique paths (`Composition/vpc`), traversal via `node.findAll()`.

### Proxy System (`tracking/`)

Two proxy types with clear semantics:

**`ReadProxy`** — wraps observed data. Property access records the path. Carries source metadata (owner resource + path) for dependency edge creation.

**`WriteProxy`** — wraps desired data. When a `ReadProxy` value is assigned to a write proxy, it registers a dependency edge and stores a `Pending(source)` marker.

```ts
// User writes:
subnet.spec.forProvider.vpcId = vpc.status.atProvider.id;

// Internally:
// 1. vpc.status.atProvider.id → ReadProxy, records path "status.atProvider.id" on resource "vpc"
// 2. Assignment into subnet's WriteProxy detects the ReadProxy value
// 3. EdgeCollector records: subnet depends on vpc at "status.atProvider.id"
// 4. Pending marker stored at subnet.desired["spec.forProvider.vpcId"]
```

Metadata is stored in a `WeakMap` — no symbols pollute proxy objects.

### Context & AsyncLocalStorage (`core/context.ts`)

Composition context is injected via `AsyncLocalStorage`:

```ts
compositionStorage.run(ctx, () => new UserComposition());
```

The `Composition` constructor reads from ALS — no statics, no globalThis. Works naturally with bundled copies and VM sandboxes.

Context contains:
- `xr` — the observed XR data
- `pipelineContext` — Crossplane function pipeline context
- `requiredResources` — observed external resources
- `graph` — `DependencyGraph` instance
- `collector` — `EdgeCollector` instance

### Resource Model (`core/resource.ts`)

A resource is a single proxy with "desired-first, fallback-to-observed" semantics:

| Action | Path in desired? | Behavior |
|--------|-----------------|----------|
| **Read** | Yes | Returns the desired value (concrete, no edge) |
| **Read** | No | Returns ReadProxy from observed (creates edge if used) |
| **Write** | — | Always writes to desired |

Constructor props become the initial desired document. Any K8s object shape is supported — no assumptions about spec/status.

Reserved framework properties (not proxied):
- `node` — from Construct (tree traversal, explicit dependencies)
- `resource` — framework config namespace (autoReady, ready checks)

### XR Proxy (`core/composition.ts`)

`this.xr` uses the same desired-first semantics:
- Reading `this.xr.spec.region` → falls through to observed
- Writing `this.xr.status.vpcId = vpc.status.atProvider.id` → writes to desired, creates edge

### Pipeline (`pipeline/`)

Five pure-function phases, each transforming `PipelineState`:

```
hydrate → resolve → sequence → diagnose → emit
```

1. **Hydrate** — feeds observed state from Crossplane into each resource's observed store
2. **Resolve** — walks dependency edges; replaces `Pending` markers with concrete values where observed data is available
3. **Sequence** — topological sort on dependency graph; classifies resources as `emit` or `blocked`
4. **Diagnose** — for blocked resources, produces structured diagnostics (pending paths, cycles)
5. **Emit** — serializes emitted resources' desired documents to plain K8s objects

### Readiness (`readiness/`)

After the pipeline, each emitted resource is evaluated for readiness:
- **Auto-ready** (default): checks observed status for a `True` condition with type `Ready` or `Synced`
- **Custom checks**: user-defined functions `(observed) => boolean`
- Readiness is reported per-resource in the `CompositionResult`

### `runComposition()` (`run.ts`)

The single entry point bridging a Composition class to plain-data output:

```ts
function runComposition<TSpec, TStatus, TContext extends object>(
  CompositionClass: new () => Composition<TSpec, TStatus, TContext>,
  input: CompositionInput,
): CompositionResult
```

Handles: context setup → ALS instantiation → pipeline execution → readiness evaluation → result serialization.

---

## Function Runtime (`@xplane/function`)

### Handler (`handler.ts`)

Thin adapter between the Crossplane Function SDK and `@xplane/core`:

1. Extracts `CompositionInput` from `RunFunctionRequest` (XR, observed composed, context, required resources)
2. Loads the composition module via a `CompositionLoader`
3. Calls `module.run(input)` → gets `CompositionResult`
4. Maps result back to `RunFunctionResponse` (SDK resources, conditions, context)
5. Handles iteration tracking for required resources

### Loaders (`loader/`)

**`DispatchLoader`** — routes to the appropriate loader based on the input's `kind` field.

**`GitLoader`** — clones a git repository, loads the bundled JS from the specified path.

**`InlineLoader`** — evaluates inline JavaScript code in a VM sandbox.

### VM Sandbox (`loader/sandbox.ts`)

Evaluates CJS code in an isolated `vm.Context`:

- Provides standard JS globals (console, JSON, Map, Set, etc.)
- Provides framework globals for thin bundles: `Composition`, `Resource`, `Construct`, `runComposition`
- Code must export `exports.run` — a function matching `CompositionModule`
- 5-second timeout for execution

**Full bundles** carry their own `@xplane/core` and only use standard JS globals.
**Thin bundles** (inline code) use the sandbox-provided framework globals — they run on the runtime's installed `@xplane/core` version.

---

## Devtools (`@xplane/devtools`)

### Template

Snapshot of all declared resources from a Composition (both emittable and blocked). Provides assertion methods:

- `resourceCountIs(apiVersion, kind, count)`
- `hasResourceSpec(apiVersion, kind, partial)`
- `hasResource(apiVersion, kind, partial)`

### Simulator

Full pipeline simulation with mock observed state:

```ts
Simulator.synthesize(MyComposition, { xr })
  .withObserved([...])
  .run();
// → { emitted: Template, blocked: Template }
```

### Match

Matchers for assertions: `Match.pending()`, `Match.objectLike()`, `Match.arrayWith()`.

---

## Data Flow: End to End

```
Crossplane reconcile loop
        │
        ▼
RunFunctionRequest (protobuf)
        │
        ▼  @xplane/function handler
┌───────────────────────────┐
│ Extract CompositionInput  │
│ Load composition module   │
│ Call module.run(input)    │
└───────────┬───────────────┘
            │
            ▼  @xplane/core runComposition()
┌───────────────────────────┐
│ AsyncLocalStorage.run()   │
│ new UserComposition()     │  ← constructs tree, records edges
│ runPipeline()             │  ← hydrate/resolve/sequence/diagnose/emit
│ evaluateReadiness()       │
│ return CompositionResult  │
└───────────┬───────────────┘
            │
            ▼  @xplane/function handler
┌───────────────────────────┐
│ Map to RunFunctionResponse│
│ Set desired resources     │
│ Set conditions/warnings   │
│ Set requireResource calls │
└───────────┬───────────────┘
            │
            ▼
RunFunctionResponse (protobuf)
        │
        ▼
Crossplane applies desired state
```

---

## Dependency Resolution & Sequencing

Resources form a DAG based on cross-resource reads:

```ts
const vpc = new VPC(this, 'vpc', { ... });
const subnet = new Subnet(this, 'subnet', {
  spec: { forProvider: { vpcId: vpc.status.atProvider.id } }
});
```

Reading `vpc.status.atProvider.id` creates a dependency edge: `subnet → vpc`.

On each Crossplane reconcile iteration:
1. VPC is emitted immediately (no dependencies)
2. Subnet is **blocked** — `Pending` marker at `spec.forProvider.vpcId`
3. Next iteration: Crossplane provides VPC's observed status
4. Pipeline resolves `Pending` → concrete value `"vpc-123"`
5. Subnet is now emitted with the resolved value

Circular dependencies are detected during the sequence phase and reported as diagnostics — not thrown.

---

## Existing (Required) Resources

`Resource.fromExistingByName()` creates a resource marked as `external: true`:
- Has an observed proxy (for reading status)
- No desired document (not emitted to Crossplane)
- The runtime maps these to `requireResource` calls in the response
- On the next reconcile, Crossplane provides the observed data

---

## Code Generation (`@xplane/codegen`)

Generates typed Resource subclasses from:
- **XRDs** — produces Spec/Status interfaces for the composite resource
- **CRDs** — produces typed Resource classes with spec/status types
- **OCI xpkg** — extracts CRDs from a Crossplane provider package

Generated classes provide:
- Typed constructor props (spec shape)
- Typed status (for dependency reads)
- `fromExistingByName()` static method
- Automatic `apiVersion` and `kind` — no manual strings
