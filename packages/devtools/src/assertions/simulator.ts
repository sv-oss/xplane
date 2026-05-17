import {
  type Composition,
  type DependencyGraph,
  type KubernetesResource,
  type Resource,
  resolveSequencing,
} from '@xplane/core';
import { type SynthesizeOptions, Template } from './template.js';

/** Result of a simulation run. */
export interface SimulationResult {
  /** Resources that are ready to emit (all dependencies satisfied). */
  emitted: Template;
  /** Resources that are blocked on unresolved dependencies. */
  blocked: Template;
}

// ─── Path Utilities (same logic as @xplane/function handler) ─────────

function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (!(seg in current) || typeof current[seg] !== 'object' || current[seg] === null) {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  const lastSeg = segments[segments.length - 1];
  if (lastSeg !== undefined) {
    current[lastSeg] = value;
  }
}

/**
 * Simulates the full rendering pipeline including observed state injection,
 * edge resolution, and sequencing — mimicking what `@xplane/function` does at runtime.
 *
 * @example
 * ```ts
 * const result = Simulator.synthesize(MyComposition, { xr: { ... } })
 *   .withObserved([{ apiVersion: '...', kind: 'VPC', metadata: { name: 'vpc-abc' }, status: { atProvider: { vpcId: 'vpc-123' } } }])
 *   .run();
 *
 * result.emitted.hasResourceSpec('ec2.aws.crossplane.io/v1beta1', 'Subnet', {
 *   forProvider: { vpcId: 'vpc-123' },
 * });
 * ```
 */
export class Simulator {
  private readonly _composition: Composition;
  private _observed: KubernetesResource[] = [];

  private constructor(composition: Composition) {
    this._composition = composition;
  }

  /**
   * Ergonomic factory: injects XR/environment data, instantiates the
   * Composition class, and returns a Simulator ready for `.withObserved().run()`.
   */
  static synthesize(Ctor: new () => Composition, options: SynthesizeOptions = {}): Simulator {
    // Find base Composition class with _pendingXR
    let base = Ctor as unknown as Record<string, unknown>;
    while (base && !Object.hasOwn(base, '_pendingXR')) {
      base = Object.getPrototypeOf(base) as Record<string, unknown>;
    }
    if (!base) {
      throw new Error('Could not find Composition base class with _pendingXR');
    }

    const BaseComposition = base as unknown as {
      _pendingXR: Record<string, unknown> | undefined;
      _pendingEnvironment: Record<string, unknown> | undefined;
    };

    BaseComposition._pendingXR = options.xr;
    BaseComposition._pendingEnvironment = options.environment;
    try {
      const instance = new Ctor();
      return new Simulator(instance);
    } finally {
      BaseComposition._pendingXR = undefined;
      BaseComposition._pendingEnvironment = undefined;
    }
  }

  /**
   * Build a Simulator from an already-instantiated Composition.
   */
  static fromComposition(composition: Composition): Simulator {
    return new Simulator(composition);
  }

  /**
   * Provide observed (cluster) state for resources.
   * Each resource is matched to a declared resource by its construct path
   * (i.e., `metadata.name` in observed state maps to `resource.path` in the composition).
   */
  withObserved(resources: KubernetesResource[]): this {
    this._observed = resources;
    return this;
  }

  /**
   * Run the simulation: inject observed state, resolve edges, determine sequencing.
   */
  run(): SimulationResult {
    const composition = this._composition;
    const resources = (composition as unknown as { resources: ReadonlyMap<string, ResourceLike> })
      .resources;
    const collector = (
      composition as unknown as { collector: { edges: ReadonlyArray<DependencyEdgeLike> } }
    ).collector;
    const graph = (composition as unknown as { graph: DependencyGraph }).graph;

    // Build observed map keyed by resource path (same as handler)
    const observedMap = new Map<string, KubernetesResource>();
    for (const obs of this._observed) {
      const name = obs.metadata?.name;
      if (name) {
        observedMap.set(name, obs);
      }
    }

    // Add edges to graph
    graph.addEdges(collector.edges);

    // Feed observed state into resources
    for (const [path, resource] of resources) {
      const observed = observedMap.get(path);
      if (observed) {
        resource.setObserved(observed);
      }
    }

    // Resolve cross-resource edge values from observed state
    for (const edge of collector.edges) {
      const observed = observedMap.get(edge.from.id);
      if (!observed) continue;

      const value = getNestedValue(observed, edge.fromPath);
      if (value === undefined || value === null) continue;

      const targetResource = resources.get(edge.to.id);
      if (!targetResource) continue;

      const toPath = edge.toPath;
      if (toPath.startsWith('spec.')) {
        setNestedValue(
          targetResource.spec as Record<string, unknown>,
          toPath.slice('spec.'.length),
          value,
        );
      }
    }

    // Resolve sequencing
    const sequencing = resolveSequencing(
      resources as unknown as ReadonlyMap<string, Resource>,
      graph as DependencyGraph,
      observedMap,
    );

    return {
      emitted: Template.fromResources(sequencing.emit.map((r) => r.toDesired())),
      blocked: Template.fromResources(sequencing.blocked.map((r) => r.toDesired())),
    };
  }
}

// ─── Internal type helpers (avoid importing private types) ───────────

interface ResourceLike {
  path: string;
  spec: Record<string, unknown>;
  setObserved(observed: KubernetesResource): void;
  toDesired(): KubernetesResource;
}

interface DependencyEdgeLike {
  from: { id: string };
  fromPath: string;
  to: { id: string };
  toPath: string;
}
