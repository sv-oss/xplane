> ⚠️ **Status**: This project is in early alpha and under active development. The API is not stable and may change significantly without notice. **Production use is not recommended at this time.**

---

# xplane

A **TypeScript framework** for building [Crossplane](https://www.crossplane.io/) composition functions with first-class dependency tracking, resource composition, and automatic ready detection.

## Overview

xplane simplifies authoring Crossplane composition functions by providing a modern, ergonomic TypeScript API that automatically handles:

- **Dependency tracking**: Assigning status from one resource's output to another's spec automatically records the dependency
- **Composition scaffolding**: Declarative resource composition with proxy-wrapped `spec` and `status` for automatic tracking
- **Ready detection**: Automatic detection of when composed resources reach desired states
- **Sequencing resolution**: Compute optimal resource creation/update order based on tracked dependencies
- **Code generation**: Generate TypeScript types from Kubernetes CRDs and Crossplane providers
- **Clean runtime/framework separation**: Plain-data contract (`CompositionModule`) decouples execution from composition logic

### Inspiration

xplane is inspired by:
- **[AWS CDK](https://aws.amazon.com/cdk/)** — The construct pattern for composable, tree-based infrastructure definition
- **[function-pythonic](https://github.com/crossplane-contrib/function-pythonic)** — Built-in dependency sequencer for automatic resource ordering

## Key Features

### Core Framework (`@xplane/core`)
- **`Composition`**: Root construct for orchestrating resource composition with built-in dependency collection and sequencing
- **`Resource`**: Type-safe wrapper for Kubernetes resources with automatic dependency tracking via proxy-wrapped `spec` and `status`
- **Dependency Graph**: Automatically tracks resource dependencies and resolves creation order
- **Pipeline Engine**: Phases (hydrate → resolve → sequence → diagnose → emit) run entirely within core
- **Ready Detection**: Built-in helpers to detect when resources reach ready conditions
- **Auto-Ready**: Automatic ready detection for resources with standard Kubernetes status conditions
- **Usage Edges**: Optionally synthesize Crossplane v2 `Usage` / `ClusterUsage` resources for dependency edges so Crossplane protects dependencies from deletion while dependents still reference them. Explicit `node.addDependency(...)` edges are emitted by default; enable `usageOptions.emitImplicitEdges` to also cover field-level reads
- **`runComposition()`**: Single entry point bridging composition classes to plain-data `CompositionResult`

### Developer Tools (`@xplane/devtools`)
- **Assertions toolkit** for unit testing compositions — see [TESTING.md](TESTING.md)
- `Template` class for verifying declared resources and their properties
- `Match` matchers: `objectLike`, `arrayWith`, `stringLikeRegexp`, `absent`, `anyValue`, `not`
- `Simulator` for testing sequencing with simulated observed state
- Snapshot testing via `toJSON()`

### Code Generation (`@xplane/codegen`)
- Generate TypeScript type definitions from:
  - Local CRD files
  - Kubernetes API types (any version)
  - Crossplane provider OCI packages

### Function Runtime (`@xplane/function`)
- Thin I/O adapter between Crossplane SDK wire format and `CompositionModule.run()`
- Dispatches to loaders based on `input.kind`:
  - **InlineLoader** (`kind: Inline`): Evaluates bundled JavaScript from the `code` field in a VM sandbox
  - **GitLoader** (`kind: Git`): Clones compositions from any git repository with sparse checkout, on-disk caching, and token-based auth
  - **OciLoader** (`kind: Oci`): Pulls compositions from any OCI registry as `tar+gzip` artifacts, with digest-keyed on-disk caching and file-mounted credentials (basic, bearer token, or Docker config)
- Manages iteration tracking and max-iteration safety
- Translates `CompositionResult` back to Crossplane SDK response format
- Zero knowledge of framework internals (no WeakMaps, no AsyncLocalStorage, no proxy access)

### Cluster Utilities (`@xplane/utils`)
- Library + `xplane-utils` CLI for observing XRs created by xplane compositions
- **Watcher**: list/watch an XR via `@kubernetes/client-node`, building a unified `XrSnapshot` (ready state, emitted/blocked composed resources from `status.xplane`, sync/throttle conditions, Kubernetes Events)
- **Renderers**: auto-selecting TTY (live-updating tree + event tail via `log-update`) or CI (append-only with heartbeats, delta lines, and periodic unready/blocked snapshots) output
- CLI subcommands:
  - `npx @xplane/utils watch <resource>/<name> [-n <ns>]` — block until the XR becomes Ready, surfacing blocked resources, sync errors, and warning events
  - `npx @xplane/utils get-status <resource>/<name> [-n <ns>] [-o dot|json]` — print the XR's `.status` as dot-notation lines or JSON (excludes `status.xplane` and `status.conditions` by default; opt-in via `--include-xplane` / `--include-conditions`)

## Architecture

The runtime (`@xplane/function`) and framework (`@xplane/core`) communicate via a plain-data contract:

```
CompositionInput (plain data) → CompositionModule.run() → CompositionResult (plain data)
```

- **`CompositionInput`**: `xr`, `pipelineContext`, `observedComposed`, `observedRequired`
- **`CompositionResult`**: `resources`, `externalResources`, `xrStatus`, `diagnostics`

No class instances, proxies, or shared mutable state crosses this boundary. See [FRAMEWORK.md](FRAMEWORK.md) for detailed architecture documentation.

## Quick Start

### Installation

#### Deploy on the Function Runtime on Kubernetes

```bash
cat <<EOF | kubectl apply -f -
apiVersion: pkg.crossplane.io/v1
kind: Function
metadata:
  name: xplane-function
spec:
  package: ghcr.io/sv-oss/function-xplane:latest
EOF
```

### Usage

The runtime uses a `DispatchLoader` that routes to the appropriate loader based on `input.kind`:

- **`kind: Inline`** — evaluates bundled JavaScript from the `code` field
- **`kind: Git`** — clones composition code from a git repository
- **`kind: Oci`** — pulls composition code from an OCI registry artifact

#### Inline Loader

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
spec:
  pipeline:
    - step: render
      functionRef:
        name: your-function
      input:
        apiVersion: inputs.xplane.io/v1alpha1
        kind: Inline
        spec:
          code: |
            class MyComposition extends Composition { ... }
            exports.run = (input) => runComposition(MyComposition, input);
```

#### Git Loader

The `GitLoader` loads composition code directly from a git repository using sparse checkout. It supports any git hosting provider over HTTPS and authenticates via a token file (e.g. a Kubernetes secret mount).

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
spec:
  pipeline:
    - step: render
      functionRef:
        name: your-function
      input:
        apiVersion: inputs.xplane.io/v1alpha1
        kind: Git
        spec:
          url: https://github.com/org/compositions
          ref: main
          path: vpc/dist              # directory (uses entryPoint)
          entryPoint: index.js        # optional, default: index.js
          tokenPath: /var/secrets/git-token  # mounted k8s secret
          provider: github            # github | gitlab | bitbucket
```

**Fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | yes | — | HTTPS URL of the git repository |
| `path` | yes | — | File (`.js`/`.cjs`/`.mjs`) or directory within the repo |
| `ref` | no | HEAD | Branch, tag, or commit to checkout |
| `entryPoint` | no | `index.js` | File to evaluate when `path` is a directory |
| `tokenPath` | no | — | Path to a file containing the auth token |
| `provider` | no | `github` | Auth format: `github`, `gitlab`, or `bitbucket` |

**Behavior:**
- Shallow clone (`depth: 1`, single branch) with sparse checkout — only the specified file/directory is written to disk
- On-disk cache under `/tmp/xplane-git-cache/` — subsequent calls fetch updates instead of re-cloning
- Auth token is read from `tokenPath` at load time and formatted per provider conventions

#### OCI Loader

The `OciLoader` pulls composition code from an OCI registry artifact. Each artifact is a standard OCI image manifest (`artifactType: application/vnd.xplane.composition.v1`) with **exactly one `tar+gzip` layer** containing the composition directory. The entry file inside the tarball defaults to `index.js`.

Publish one composition per artifact (one repository, one tag) so promotion, signing, scanning, and mirroring work per-composition with standard OCI tooling.

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: Composition
spec:
  pipeline:
    - step: render
      functionRef:
        name: your-function
      input:
        apiVersion: inputs.xplane.io/v1alpha1
        kind: Oci
        spec:
          registry: ghcr.io
          repository: org/compositions/vpc
          tag: v1.2.3                      # or `digest: sha256:...`
          tagPullPolicy: Always            # optional, default: Always
          entryPoint: index.js             # optional, default: index.js
          auth:                            # optional; omit for anonymous pulls
            type: dockerConfig             # basic | token | dockerConfig
            configPath: /var/secrets/oci/config.json
```

**Top-level fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `registry` | yes | — | Registry hostname (e.g. `ghcr.io`, `123.dkr.ecr.us-east-1.amazonaws.com`) |
| `repository` | yes | — | Repository path within the registry |
| `tag` | one of | — | Tag to resolve via `getManifest()` on every load |
| `digest` | one of | — | Pinned digest (`sha256:…`); skips manifest re-resolution on cache hit |
| `tagPullPolicy` | no | `Always` | `Always` re-resolves the manifest every load; `IfNotPresent` skips the registry round-trip when the tag has been resolved before and the extracted layer is still cached. Ignored when `digest` is set. |
| `entryPoint` | no | `index.js` | File inside the tarball to evaluate |
| `auth` | no | anonymous | Credential source — see below |

Exactly one of `tag` or `digest` must be set.

**Authentication methods** (all token material is read from files — typically Kubernetes secret mounts — never inline in the spec):

| `auth.type` | Required fields | Behavior |
|-------------|-----------------|----------|
| _omitted_ | — | Anonymous pull |
| `basic` | `usernamePath`, `passwordPath` | Reads each file (trimmed) and sends `Authorization: Basic <base64(user:pass)>` |
| `token` | `tokenPath` | Reads the file (trimmed) and sends `Authorization: Bearer <token>` |
| `dockerConfig` | `configPath` | Resolves credentials for `registry` from a Docker `config.json` (basic auth) |

Example with a Kubernetes secret containing `username` and `password` keys:

```yaml
spec:
  registry: ghcr.io
  repository: org/compositions/vpc
  tag: v1.2.3
  auth:
    type: basic
    usernamePath: /var/secrets/oci/username
    passwordPath: /var/secrets/oci/password
```

**Behavior:**
- Tag references re-resolve the manifest on every load so a moving tag picks up updates; digest references skip the round-trip on cache hit.
- `tagPullPolicy: IfNotPresent` (Kubernetes `imagePullPolicy` semantics) skips the manifest fetch entirely when a previous load already resolved the same tag and its extracted layer is still on disk. Use this for immutable tags (e.g. commit-SHA tags) where the small staleness window is acceptable in exchange for zero registry traffic on subsequent loads.
- On-disk cache under `/tmp/xplane-oci-cache/<layer-digest>/` — the tarball is fetched and extracted only on a cache miss. Tag→digest pointers are stored under `/tmp/xplane-oci-cache/tags/`.
- Rejects manifests with zero or more than one layer, and any layer that is not `application/vnd.oci.image.layer.v1.tar+gzip` (or uncompressed `.tar`).
- Tar extraction is strict (no absolute paths or `..` traversal).


### Framework Usage

See [FRAMEWORK.md](FRAMEWORK.md) for detailed documentation and examples of using the core framework to author compositions in TypeScript.


## Code Generator

`xplane` ships with a first class code generation CLI called `@xplane/codegen` that turns Kubernetes-style schemas into the TypeScript types and Helm scaffolding compositions need. The CLI supports multiple input sources (local files, remote URLs, OCI packages) and can generate from plain Kubernetes CRDs, Crossplane XRDs, Kubernetes API schemas, or entire Crossplane provider packages.

### Install

```bash
pnpm add -D @xplane/codegen
# or invoke directly
npx @xplane/codegen --help
```

### `generate-types-from` — TypeScript types

Generates one `.ts` file per `<group>/<version>` plus a barrel `index.ts` (suppress with `--no-barrel`). Each file declares `interface <Kind>Spec`, `interface <Kind>Status`, `interface <Kind>Props`, and a `class <Kind> extends Resource` that compositions can `new` directly. Interface names are namespaced (`<Group>V<Version><Kind>…`) to prevent collisions across API groups.

| Subcommand | Source |
|-----------|--------|
| `xrd`  | Crossplane `CompositeResourceDefinition` YAML (local path, `file://`, `https://`, or comma-separated list) |
| `crd`  | Plain Kubernetes `CustomResourceDefinition` YAML (same URI rules as `xrd`) |
| `k8s`  | Kubernetes core API schema for a specific version (`--k8s-version v1.31.0`) |
| `xpkg` | Crossplane provider OCI package (`--oci xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0`); optionally restrict with `--groups` |

Shared flags: `--output-dir` (required), `--no-barrel`, `--readonly` (prefix all interface properties with `readonly`).

```bash
npx @xplane/codegen generate-types-from xrd \
  --uri ./apis/definitions/project.yaml,./apis/definitions/tide-app.yaml \
  --output-dir src/schemas/xrds

npx @xplane/codegen generate-types-from xpkg \
  --oci xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0 \
  --output-dir src/schemas/crossplane-providers
```

For the `xpkg` subcommand, registry credentials are auto-detected from `$DOCKER_CONFIG/config.json` (or `~/.docker/config.json`) when present, or can be supplied explicitly via one of:

| Flag(s) | Auth |
|---------|------|
| `--username <u> --password <p>` | HTTP Basic |
| `--token <t>` | Bearer token |
| `--docker-config <path>` | Docker `config.json` at the given path |

These three modes are mutually exclusive; if none are set the resolver falls back to the auto-detected docker config or anonymous access.

### `generate-helm-from` — Helm charts

Generates a minimal Helm chart per XRD whose only resource is the XR itself. All `spec.*` fields become first-class Helm values, and the XRD's `openAPIV3Schema` becomes `values.schema.json` so `helm install` / `helm template` validate input automatically.

| Subcommand | Source |
|-----------|--------|
| `xrd` | Crossplane `CompositeResourceDefinition` YAML (same URI rules as type generation) |

Flags: `--uri`, `--output-dir` (required); `--chart-version` (default `0.1.0`).

```bash
npx @xplane/codegen generate-helm-from xrd \
  --uri ./apis/definitions/tide-app.yaml \
  --output-dir charts
```

**Chart layout** (one per `(XRD, served version)`):

```
<output-dir>/<plural>-<version>/
  Chart.yaml           # name=<plural>, version=<chart-version>, appVersion=<xrd-version>
  values.yaml          # `spec:` populated from `default:` fields in the XRD; falls back to `spec: {}`
  values.schema.json   # XRD spec schema, used by helm to validate --set / -f input
  templates/xr.yaml    # the XR manifest; spec = {{ toYaml .Values.spec | nindent 2 }}
```

The XR's `metadata.name` is `{{ .Release.Name }}`; for `Namespaced` XRDs `metadata.namespace` is `{{ .Release.Namespace }}`. Override any field via `--set spec.<path>=…` or a values file, e.g.:

```bash
npx @xplane/codegen my-app charts/tideapps-v1alpha1 \
  --set spec.environmentName=dev \
  --set spec.cms.image=myrepo/cms:1.2.3 \
  --namespace apps
```

## Contributing

Issues and pull requests are welcome. Please ensure all tests pass and code passes Biome linting before submitting.

see [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT © 2026 Service Victoria
