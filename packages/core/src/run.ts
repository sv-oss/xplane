import type {
  BlockedResource,
  CompositionInput,
  CompositionResult,
  DesiredResource,
  ExternalResourceRequest,
} from './contract.js';
import type { Composition } from './core/composition.js';
import type { CompositionContext } from './core/context.js';
import { compositionStorage } from './core/context.js';
import { getDesiredDocument, getExternalRef, getResourceRef, isExternal } from './core/resource.js';
import { runPipeline } from './pipeline/index.js';
import { DEFAULT_CHECKS, evaluateReadiness } from './readiness/index.js';
import { DependencyGraph, EdgeCollector } from './tracking/index.js';
import { createTokenRegistry, tokenRegistryStorage } from './tracking/token-registry.js';

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
    observedComposed,
    graph,
    collector,
  };

  // Instantiate composition within ALS context
  const composition = compositionStorage.run(ctx, () =>
    tokenRegistryStorage.run(createTokenRegistry(), () => new CompositionClass()),
  ) as Composition;

  // Run the pipeline
  const state = runPipeline({ composition, observedComposed, observedRequired });

  // Build the result — plain data only
  const resources: DesiredResource[] = state.emitted.map((emitted) => {
    const k8sName = extractMetadataName(emitted.document);
    const namespace = extractMetadataNamespace(emitted.document);
    if (emitted.preserved) {
      // Blocked resource being emitted as its observed state — mark not ready.
      return {
        nodePath: emitted.name,
        document: emitted.document,
        ready: false,
        preserved: true,
        ...(k8sName ? { name: k8sName } : {}),
        ...(namespace ? { namespace } : {}),
      };
    }
    const allChecks = [...emitted.readyChecks, ...DEFAULT_CHECKS];
    // Look up observed using the full construct path (Composition/{name})
    const observed = observedComposed.get(`Composition/${emitted.name}`);
    const ready = emitted.autoReady ? evaluateReadiness(allChecks, observed) : true;

    return {
      nodePath: emitted.name,
      document: emitted.document,
      ready,
      ...(k8sName ? { name: k8sName } : {}),
      ...(namespace ? { namespace } : {}),
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

  // Collect blocked resource info so the handler can preserve observed state
  // in desired (preventing accidental deletion), prevent premature XR readiness,
  // and surface a structured `status.xplane.blockedResources` entry on the XR.
  const blockedResources: BlockedResource[] = [];
  for (const resource of state.resources) {
    if (isExternal(resource)) continue;
    const ref = getResourceRef(resource);
    if (state.classification.get(ref.id) !== 'blocked') continue;
    const nodePath = ref.id.startsWith('Composition/')
      ? ref.id.slice('Composition/'.length)
      : ref.id;
    const desired = getDesiredDocument(resource);
    const apiVersion = typeof desired.apiVersion === 'string' ? desired.apiVersion : '';
    const kind = typeof desired.kind === 'string' ? desired.kind : '';
    const k8sName = extractMetadataName(desired);
    const namespace = extractMetadataNamespace(desired);
    const waitingFor = describeWaitingFor(nodePath, state.diagnostics);
    blockedResources.push({
      nodePath,
      apiVersion,
      kind,
      ...(k8sName ? { name: k8sName } : {}),
      ...(namespace ? { namespace } : {}),
      ...(waitingFor && waitingFor.length > 0 ? { waitingFor } : {}),
    });
  }

  return {
    resources,
    blockedResources,
    externalResources,
    xrStatus: state.xrStatusPatches,
    diagnostics: state.diagnostics,
    emitXplaneStatus: composition.emitXplaneStatus === true,
  };
}

/**
 * Build a human-readable `waitingFor` list for a blocked resource from the
 * matching diagnostic. Each entry describes one thing the resource is waiting
 * on (one entry per pending path, or a single entry for cycle/not-found).
 */
function describeWaitingFor(
  name: string,
  diagnostics: ReadonlyArray<{
    resource: string;
    reason: 'pending' | 'cycle' | 'not-found' | 'dependency';
    pendingPaths?: Array<{ path: string; waitingOn: { resource: string; path: string } }>;
    cycle?: string[];
    detail?: string;
    waitingOn?: string[];
  }>,
): string[] | undefined {
  const id = `Composition/${name}`;
  const diag = diagnostics.find((d) => d.resource === id || d.resource === name);
  if (!diag) return undefined;

  if (diag.reason === 'cycle') {
    return [`circular dependency: ${(diag.cycle ?? []).join(' → ')}`];
  }
  if (diag.reason === 'not-found') {
    return [diag.detail ?? 'external resource not found'];
  }
  if (diag.reason === 'dependency' && diag.waitingOn && diag.waitingOn.length > 0) {
    return diag.waitingOn.map((dep) => {
      const stripped = dep.startsWith('Composition/') ? dep.slice('Composition/'.length) : dep;
      return `${stripped} to be Ready`;
    });
  }
  if (diag.pendingPaths && diag.pendingPaths.length > 0) {
    return diag.pendingPaths.map((p) => {
      const dep = p.waitingOn.resource.startsWith('Composition/')
        ? p.waitingOn.resource.slice('Composition/'.length)
        : p.waitingOn.resource;
      return `${dep}.${p.waitingOn.path}`;
    });
  }
  return undefined;
}

function extractMetadataName(doc: Record<string, unknown>): string | undefined {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const name = (metadata as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function extractMetadataNamespace(doc: Record<string, unknown>): string | undefined {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const namespace = (metadata as Record<string, unknown>).namespace;
  return typeof namespace === 'string' && namespace.length > 0 ? namespace : undefined;
}
