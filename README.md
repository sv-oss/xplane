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

### Code Generation (`@xplane/codegen`)
- Generate TypeScript type definitions from:
  - Local CRD files
  - Kubernetes API types (any version)
  - Crossplane provider OCI packages

### Function Runtime (`@xplane/function`)
- Drop-in Crossplane function handler implementation
- Loads composition code via pluggable loaders (inline TypeScript, etc.)
- Manages iteration, sequencing, and state reconciliation
- Integrates with Crossplane Function SDK

## Quick Start

### Installation

Installation consists of two parts:

#### 1. Install in Your Project (for development)

Add xplane packages to your TypeScript project:

```bash
npm install @xplane/core
# or
pnpm add @xplane/core
```

#### 2. Deploy on Kubernetes (instructions TBD)

To deploy your composition function as a Crossplane Function on a Kubernetes cluster, see the deployment guide (coming soon).

### Basic Usage

TBD

### Generate Types

```bash
# From CRDs
npx xplane-codegen generate crd \
  --uri https://doc.crds.dev/raw/github.com/kubernetes-sigs/karpenter@v1.5.0 \
  --output-dir src/generated

# From Kubernetes core API schema version
npx xplane-codegen generate k8s \
  --k8s-version v1.31.0 \
  --output-dir src/generated

# From a Crossplane provider
npx xplane-codegen generate xpkg \
  --oci xpkg.upbound.io/upbound/provider-aws-ec2:v2.5.0 \
  --groups ec2.aws.upbound.io \
  --output-dir src/generated
```

## Project Structure

```
packages/
├── core/              # Core composition framework
│   ├── src/
│   │   ├── core/       # Resource, Composition, construct tree
│   │   ├── tracking/   # Proxy-based dependency tracking
│   │   ├── sequencing/ # Dependency resolution & ordering
│   │   └── ready/      # Ready condition detection
│   └── __tests__/
├── codegen/           # Type generation from CRDs/providers
│   ├── src/
│   │   ├── cli.ts      # CLI entry point
│   │   ├── generator/  # Code emission logic
│   │   ├── schema/     # Resource definition types
│   │   └── sources/    # CRD, Kubernetes, OCI sources
│   └── __tests__/
└── function/          # Crossplane function runtime
    ├── src/
    │   ├── handler.ts  # CompositionHandler implementation
    │   ├── loader/     # Composition loading plugins
    │   └── serve.ts    # HTTP server for function
    └── __tests__/
```

## Development

### Prerequisites

- Node.js ≥ 24.0.0
- pnpm 9.15.4+

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint & format
pnpm lint
pnpm lint:fix

# Type check
pnpm typecheck
```

### Workspace Commands

This is a [Turborepo](https://turbo.build/) monorepo managed with `pnpm`. Common tasks:

```bash
pnpm build          # Build all packages (uses tsup)
pnpm test           # Run all test suites (uses Vitest)
pnpm lint           # Run Biome linter
pnpm lint:fix       # Auto-fix Biome violations
pnpm typecheck      # Run TypeScript type checking
pnpm clean          # Remove all dist/ and build artifacts
```

### Code Quality

- **Linting**: [Biome](https://biomejs.dev/) (formatting + linting)
- **Testing**: [Vitest](https://vitest.dev/)
- **Type Checking**: TypeScript strict mode
- **Build**: [tsup](https://tsup.egoist.dev/) (ESM + CommonJS)

## How It Works

### Dependency Tracking

Resources use `Proxy` wrappers on `spec` and `status` to intercept reads/writes:

```typescript
const vpc = new Resource(this, 'vpc', { spec: { cidr: '10.0.0.0/16' } });
const subnet = new Resource(this, 'subnet', { spec: {} });

// Reading vpc.status.id automatically records a dependency:
// vpc → subnet
subnet.spec.vpcId = vpc.status.id;
```

### Composition Lifecycle

1. **Instantiation**: Subclass `Composition`, add `Resource` instances in constructor
2. **Composition**: Framework collects resources and builds dependency graph
3. **Sequencing**: `resolveSequencing()` computes creation order from dependency edges
4. **Reconciliation**: `CompositionHandler` iteratively applies desired state, respecting sequencing
5. **Ready Detection**: Auto-ready checks if resources have reached target conditions

## License

MIT © 2026 Service Victoria

## Contributing

Issues and pull requests are welcome. Please ensure all tests pass and code passes Biome linting before submitting.

```bash
pnpm lint:fix
pnpm test
```
