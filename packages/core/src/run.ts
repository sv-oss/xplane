import type {
  CompositionInput,
  CompositionResult,
  DesiredResource,
  ExternalResourceRequest,
} from './contract.js';
import type { Composition } from './core/composition.js';
import type { CompositionContext } from './core/context.js';
import { compositionStorage } from './core/context.js';
import { getExternalRef, isExternal } from './core/resource.js';
import { runPipeline } from './pipeline/index.js';
import { DEFAULT_CHECKS, evaluateReadiness } from './readiness/index.js';
import { DependencyGraph, EdgeCollector } from './tracking/index.js';

/**
 * Run a composition class with the given input and return a plain-data result.
 *
 * This is the single entry point that bridges the composition author's class
 * with the runtime. It handles:
 * 1. Setting up internal context (DependencyGraph, EdgeCollector, ALS)
 * 2. Instantiating the Composition class
 * 3. Running the full pipeline (hydrate → resolve → sequence → diagnose → emit)
 * 4. Evaluating readiness per resource
 * 5. Returning a fully serializable CompositionResult
 *
 * The runtime never needs to access framework internals — everything it needs
 * is in the returned plain-data structure.
 */
export function runComposition<TSpec, TStatus, TContext extends object>(
  CompositionClass: new () => Composition<TSpec, TStatus, TContext>,
  input: CompositionInput,
): CompositionResult {
  // Convert plain Records to Maps for the internal pipeline
  const observedComposed = new Map(Object.entries(input.observedComposed));
  const observedRequired = new Map(Object.entries(input.observedRequired));

  // Set up internal context
  const graph = new DependencyGraph();
  const collector = new EdgeCollector();
  const pipelineContext = new Map(Object.entries(input.pipelineContext));

  const ctx: CompositionContext = {
    xr: input.xr,
    pipelineContext,
    requiredResources: observedRequired,
    graph,
    collector,
  };

  // Instantiate composition within ALS context
  const composition = compositionStorage.run(ctx, () => new CompositionClass()) as Composition;

  // Run the pipeline
  const state = runPipeline({ composition, observedComposed, observedRequired });

  // Build the result — plain data only
  const resources: DesiredResource[] = state.emitted.map((emitted) => {
    const allChecks = [...emitted.readyChecks, ...DEFAULT_CHECKS];
    // Look up observed using the full construct path (Composition/{name})
    const observed = observedComposed.get(`Composition/${emitted.name}`);
    const ready = emitted.autoReady ? evaluateReadiness(allChecks, observed) : true;

    return {
      name: emitted.name,
      document: emitted.document,
      ready,
    };
  });

  const externalResources: ExternalResourceRequest[] = [];
  for (const resource of state.resources) {
    if (!isExternal(resource)) continue;
    const ref = getExternalRef(resource);
    if (!ref || typeof ref.name !== 'string') continue;
    if (ref.name.startsWith('__pending__')) continue;

    externalResources.push({
      refKey: ref.refKey,
      apiVersion: ref.apiVersion,
      kind: ref.kind,
      name: ref.name,
      ...(ref.namespace ? { namespace: ref.namespace } : {}),
    });
  }

  return {
    resources,
    externalResources,
    xrStatus: state.xrStatusPatches,
    diagnostics: state.diagnostics,
  };
}
