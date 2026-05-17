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

### Inspiration

xplane is inspired by:
- **[AWS CDK](https://aws.amazon.com/cdk/)** — The construct pattern for composable, tree-based infrastructure definition
- **[function-pythonic](https://github.com/crossplane-contrib/function-pythonic)** — Built-in dependency sequencer for automatic resource ordering

## Key Features

### Core Framework (`@xplane/core`)
- **`Composition`**: Root construct for orchestrating resource composition with built-in dependency collection and sequencing
- **`Resource`**: Type-safe wrapper for Kubernetes resources with automatic dependency tracking via proxy-wrapped `spec` and `status`
- **Dependency Graph**: Automatically tracks resource dependencies and resolves creation order
- **Ready Detection**: Built-in helpers to detect when resources reach ready conditions
- **Auto-Ready**: Automatic ready detection for resources with standard Kubernetes status conditions

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
- Drop-in Crossplane function handler implementation
- Dispatches to loaders based on `input.kind`:
  - **InlineLoader** (`kind: Inline`): Evaluates bundled JavaScript from the `code` field
  - **GitLoader** (`kind: Git`): Clones compositions from any git repository with sparse checkout, on-disk caching, and token-based auth
- Manages iteration, sequencing, and state reconciliation
- Integrates with Crossplane Function SDK

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
            exports.composition = MyComposition;
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


### Framework Usage

See [FRAMEWORK.md](FRAMEWORK.md) for detailed documentation and examples of using the core framework to author compositions in TypeScript.


## Contributing

Issues and pull requests are welcome. Please ensure all tests pass and code passes Biome linting before submitting.

see [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT © 2026 Service Victoria
