# Contribution Guide

A full contribution guide has not been published yet, but contributions are very welcome! Please open an issue or reach out if you're interested in contributing or have any questions about the project.

## Project Structure

```
packages/
├── devtools/          # Developer tools & testing utilities
│   └── src/assertions/ # Template, Match, Simulator
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
    │   │   ├── dispatch.ts # DispatchLoader (routes by input.kind)
    │   │   ├── git.ts      # GitLoader (sparse checkout from any git repo)
    │   │   ├── inline.ts   # InlineLoader (evaluate bundled JS)
    │   │   └── sandbox.ts  # Shared VM sandbox for code evaluation
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
