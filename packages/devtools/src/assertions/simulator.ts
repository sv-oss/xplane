import {
  type Composition,
  type CompositionContext,
  compositionStorage,
  DEFAULT_CHECKS,
  DependencyGraph,
  EdgeCollector,
  type EmittedResource,
  evaluateReadiness,
  getDesiredDocument,
  getExternalRef,
  isExternal,
  type KubernetesResource,
  runPipeline,
} from '@xplane/core';
import { type SynthesizeOptions, Template } from './template.js';

/** Result of a simulation run. */
export interface SimulationResult {
  /** Resources that are ready to emit (all dependencies satisfied). */
  emitted: Template;
  /** Resources that are blocked on unresolved dependencies. */
  blocked: Template;
  /** Conditions that would be set on the XR status (e.g., missing existing resources). */
  conditions: Array<{ type: string; status: string; reason: string; message: string }>;
  /**
   * Evaluate readiness of a specific emitted resource using its registered
   * readyChecks + built-in defaults against the observed state.
   *
   * @param resourceName The construct path of the resource (e.g., 'Cluster Provider Config')
   * @returns `true` if ready, `false` if not ready or resource not found
   */
  isReady(resourceName: string): boolean;
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
  private _composition: Composition | null;
  private _factory: ((existing: Record<string, Record<string, unknown>>) => Composition) | null;
  private _observed: Record<string, unknown>[] = [];
  private _existing: Record<string, Record<string, unknown>> = {};

  private constructor(
    compositionOrFactory:
      | Composition
      | ((existing: Record<string, Record<string, unknown>>) => Composition),
  ) {
    if (typeof compositionOrFactory === 'function') {
      this._composition = null;
      this._factory = compositionOrFactory;
    } else {
      this._composition = compositionOrFactory;
      this._factory = null;
    }
  }

  /**
   * Ergonomic factory: captures XR/environment data and the Composition
   * constructor, deferring instantiation to `run()` so that `withExisting()`
   * data is available for pre-hydration during construction.
   */
  static synthesize<TSpec, TStatus, TContext extends object>(
    Ctor: new () => Composition<TSpec, TStatus, TContext>,
    options: SynthesizeOptions = {},
  ): Simulator {
    const xr: Record<string, unknown> = options.xr ?? { spec: {}, status: {} };
    const pipelineContext = new Map<string, unknown>();
    if (options.environment) {
      pipelineContext.set('apiextensions.crossplane.io/environment', options.environment);
    }

    const factory = (existing: Record<string, Record<string, unknown>>) => {
      const graph = new DependencyGraph();
      const collector = new EdgeCollector();
      const requiredResources = new Map<string, Record<string, unknown>>(Object.entries(existing));
      const ctx: CompositionContext = {
        xr,
        pipelineContext,
        requiredResources,
        graph,
        collector,
      };

      return compositionStorage.run(ctx, () => new Ctor()) as Composition;
    };

    return new Simulator(factory);
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
  withObserved(resources: Record<string, unknown>[]): this {
    this._observed = resources;
    return this;
  }

  /**
   * Provide existing resource data keyed by refKey.
   * The refKey format is `apiVersion/kind/[namespace/]name`
   * (e.g., `"example.io/v1/Project/my-project"` or `"v1/Secret/default/db-creds"`).
   *
   * This simulates what Crossplane would return via the Required Resources mechanism.
   */
  withExisting(resources: Record<string, Record<string, unknown>>): this {
    this._existing = resources;
    return this;
  }

  /**
   * Run the simulation: inject observed state, resolve edges, determine sequencing.
   */
  run(): SimulationResult {
    // Instantiate composition now so that withExisting data is available for pre-hydration
    const composition = this._factory ? this._factory(this._existing) : this._composition!;

    // Build observed map keyed by construct path (Composition/<name>)
    const observedComposed = new Map<string, Record<string, unknown>>();
    for (const obs of this._observed) {
      const meta = obs.metadata as Record<string, unknown> | undefined;
      const name = meta?.name as string | undefined;
      if (name) {
        observedComposed.set(`Composition/${name}`, obs);
      }
    }

    // Build observedRequired from withExisting
    const observedRequired = new Map<string, Record<string, unknown>>(
      Object.entries(this._existing),
    );

    // Run the pipeline
    const result = runPipeline({
      composition,
      observedComposed,
      observedRequired,
    });

    // Check for missing existing resources
    const conditions: SimulationResult['conditions'] = [];
    for (const resource of result.resources) {
      if (!isExternal(resource)) continue;
      const ref = getExternalRef(resource);
      if (!ref || typeof ref.name !== 'string') continue;
      if (!observedRequired.has(ref.refKey)) {
        conditions.push({
          type: 'Ready',
          status: 'False',
          reason: 'MissingRequiredResource',
          message: `Required existing resource ${ref.kind}/${ref.name} not found in cluster`,
        });
      }
    }

    // Build templates from pipeline results
    const blockedResources = result.resources
      .filter((r) => result.classification.get(r.node.path) === 'blocked')
      .map((r) => getDesiredDocument(r) as KubernetesResource);

    // Build a lookup for readiness evaluation
    const emittedByName = new Map<string, EmittedResource>();
    for (const e of result.emitted) {
      emittedByName.set(e.name, e);
    }

    return {
      emitted: Template.fromResources(result.emitted.map((e) => e.document as KubernetesResource)),
      blocked: Template.fromResources(blockedResources),
      conditions,
      isReady(resourceName: string): boolean {
        const emitted = emittedByName.get(resourceName);
        if (!emitted) return false;
        if (!emitted.autoReady) return false;
        const allChecks = [...emitted.readyChecks, ...DEFAULT_CHECKS];
        const observed = observedComposed.get(`Composition/${resourceName}`);
        return evaluateReadiness(allChecks, observed);
      },
    };
  }
}
