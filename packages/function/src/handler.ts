import type {
  FunctionHandler,
  Logger,
  RunFunctionRequest,
  RunFunctionResponse,
  Resource as SdkResource,
} from '@crossplane-org/function-sdk-typescript';
import {
  fatal,
  fromObject,
  getContextKey,
  getDesiredComposedResources,
  getInput,
  getObservedComposedResources,
  getObservedCompositeResource,
  normal,
  Ready,
  setContextKey,
  setDesiredComposedResources,
  setDesiredCompositeStatus,
  to,
  toObject,
  warning,
} from '@crossplane-org/function-sdk-typescript';

import {
  Composition,
  type DependencyEdge,
  isResourceReady,
  type KubernetesResource,
  resolveSequencing,
} from '@xplane/core';

import type { CompositionLoader } from './loader/types.js';

/** Maximum number of reconciliation passes. */
const MAX_ITERATIONS = 5;

/** Context key for tracking iteration count across invocations. */
const ITERATION_KEY = 'xplane.function.iteration';

/**
 * Crossplane FunctionHandler that loads composition code via a
 * CompositionLoader plugin, runs compose(), resolves dependencies,
 * and returns the desired state.
 */
export class CompositionHandler implements FunctionHandler {
  private readonly _loader: CompositionLoader;

  constructor(loader: CompositionLoader) {
    this._loader = loader;
  }

  async RunFunction(req: RunFunctionRequest, logger?: Logger): Promise<RunFunctionResponse> {
    let rsp = to(req);

    // Track iteration count
    const [iterationCtxValue] = getContextKey(req, ITERATION_KEY);
    const iteration = typeof iterationCtxValue === 'number' ? iterationCtxValue + 1 : 1;

    if (iteration > MAX_ITERATIONS) {
      warning(
        rsp,
        `Max iterations (${MAX_ITERATIONS}) reached, some resources may not be fully resolved`,
      );
      return rsp;
    }

    setContextKey(rsp, ITERATION_KEY, iteration);
    logger?.info({ iteration, loader: this._loader.name }, 'Running composition');

    // Load the composition class from the input
    const input = getInput(req) ?? {};
    let CompositionClass: new () => Composition;
    try {
      CompositionClass = await this._loader.load(input as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fatal(rsp, `Failed to load composition: ${message}`);
      logger?.error({ err }, 'Failed to load composition');
      return rsp;
    }

    // Populate observed XR before construction
    const observedXR = getObservedCompositeResource(req);
    if (observedXR) {
      const xrObj = toObject(observedXR);
      if (xrObj) {
        Composition._pendingXR = xrObj;
      }
    }

    // Populate environment from function-environment-configs or other pipeline steps
    const [envValue] = getContextKey(req, 'apiextensions.crossplane.io/environment');
    if (envValue && typeof envValue === 'object' && !Array.isArray(envValue)) {
      Composition._pendingEnvironment = envValue as Record<string, unknown>;
    }

    // Create a fresh composition instance — resources are created in constructor
    let composition: Composition;
    try {
      composition = new CompositionClass();
    } catch (err) {
      Composition._pendingXR = undefined;
      const message = err instanceof Error ? err.message : String(err);
      fatal(rsp, `Composition constructor failed: ${message}`);
      logger?.error({ err }, 'Composition constructor threw an error');
      return rsp;
    }

    // Collect observed composed resources
    const observedComposed = getObservedComposedResources(req);
    const observedMap = new Map<string, KubernetesResource>();

    if (observedComposed) {
      for (const [name, observed] of Object.entries(observedComposed)) {
        const obj = toObject(observed);
        if (obj) {
          observedMap.set(name, obj as KubernetesResource);
        }
      }
    }

    logger?.debug({ keys: [...observedMap.keys()] }, 'Observed composed resource keys');

    // Collect dependency edges from the proxy collector into the graph
    composition.graph.addEdges(composition.collector.edges);

    // Resources are discovered via construct tree traversal

    // Feed observed state into resources
    for (const [path, resource] of composition.resources) {
      const observed = observedMap.get(path);
      if (observed) {
        resource.setObserved(observed);
      }
    }

    // Resolve cross-resource values using observed state.
    // During construction, assignments like `subnet.spec.vpcId = vpc.status.vpcId`
    // store UNRESOLVED sentinels. Now that we have observed data, resolve them.
    resolveEdgeValues(composition.collector.edges, composition.resources, observedMap, logger);

    // Resolve sequencing
    const sequencing = resolveSequencing(composition.resources, composition.graph, observedMap);

    logger?.info(
      {
        emit: sequencing.emit.map((r) => r.path),
        blocked: sequencing.blocked.map((r) => r.path),
        order: sequencing.order,
      },
      'Sequencing resolved',
    );

    // Build desired composed resources
    const dcds: Record<string, SdkResource> = getDesiredComposedResources(req) ?? {};

    for (const resource of sequencing.emit) {
      const desired = resource.toDesired();
      const sdkResource = fromObject(desired);

      // Set ready state based on auto-ready
      if (resource.autoReady) {
        const observed = observedMap.get(resource.path);
        sdkResource.ready = isResourceReady(observed) ? Ready.READY_TRUE : Ready.READY_UNSPECIFIED;
      }

      dcds[resource.path] = sdkResource;
    }

    setDesiredComposedResources(rsp, dcds);

    // Compute user-defined status output (evaluated after observed state is populated)
    // Deep-resolve to unwrap tracked proxies into plain values — proxy objects
    // would otherwise serialize as maps instead of primitives.
    // Then strip empty/null values from unresolved proxy placeholders.
    const rawStatus = composition.computeStatusOutput();
    const userStatus: Record<string, unknown> =
      Object.keys(rawStatus).length > 0
        ? (stripEmpty(JSON.parse(JSON.stringify(rawStatus))) as Record<string, unknown>)
        : {};
    const statusToSet: Record<string, unknown> =
      Object.keys(userStatus).length > 0 ? { ...userStatus } : {};

    // Report status and set XR readiness
    if (sequencing.blocked.length > 0) {
      const names = sequencing.blocked.map((r) => r.path).join(', ');
      normal(rsp, `Waiting on dependencies for: ${names}`);
      // Conditions always take precedence over any user-supplied conditions key
      statusToSet.conditions = [
        {
          type: 'Ready',
          status: 'False',
          reason: 'WaitingOnDependencies',
          message: `Waiting on: ${names}`,
          lastTransitionTime: new Date().toISOString(),
        },
      ];
    }

    if (Object.keys(statusToSet).length > 0) {
      rsp = setDesiredCompositeStatus({ rsp, status: statusToSet });
    }

    if (sequencing.blocked.length === 0 && iteration > 1) {
      normal(rsp, `All resources resolved after ${iteration} iterations`);
    }

    return rsp;
  }
}

/**
 * Navigate into a nested object following a dot-separated path.
 * Returns undefined if any segment is missing.
 */
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

/**
 * Set a value in a nested object following a dot-separated path.
 * Creates intermediate objects as needed.
 */
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
 * After compose() records dependency edges with UNRESOLVED sentinels,
 * this function resolves concrete values from observed state into
 * the dependent resource's desired spec.
 *
 * For each edge (from → to):
 *   - Read the value at `fromPath` from the source resource's observed state
 *   - Write it at `toPath` on the target resource's spec proxy
 */
function resolveEdgeValues(
  edges: ReadonlyArray<DependencyEdge>,
  resources: ReadonlyMap<string, { path: string; spec: Record<string, unknown> }>,
  observedMap: ReadonlyMap<string, KubernetesResource>,
  logger?: Logger,
): void {
  for (const edge of edges) {
    const observed = observedMap.get(edge.from.id);
    if (!observed) {
      logger?.debug(
        { from: edge.from.id, path: edge.fromPath },
        'Edge source not yet observed, skipping',
      );
      continue;
    }

    const value = getNestedValue(observed, edge.fromPath);
    if (value === undefined || value === null) {
      logger?.debug(
        { from: edge.from.id, path: edge.fromPath },
        'Edge source field not yet available',
      );
      continue;
    }

    const targetResource = resources.get(edge.to.id);
    if (!targetResource) continue;

    // Write the resolved value into the target resource's spec proxy.
    // toPath is like "spec.forProvider.vpcId" — strip the "spec." prefix
    // since we're writing directly to the spec proxy.
    const toPath = edge.toPath;
    if (toPath.startsWith('spec.')) {
      setNestedValue(
        targetResource.spec as Record<string, unknown>,
        toPath.slice('spec.'.length),
        value,
      );
    }

    logger?.info(
      { from: edge.from.id, fromPath: edge.fromPath, to: edge.to.id, toPath: edge.toPath, value },
      'Resolved edge value',
    );
  }
}

/**
 * Recursively strip null, undefined, and empty object values.
 * Unresolved proxy placeholders serialize as empty objects `{}`
 * and must not be sent to Crossplane as status fields.
 */
function stripEmpty(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;

  if (Array.isArray(obj)) {
    const filtered = obj.map(stripEmpty).filter((v) => v !== undefined);
    return filtered.length > 0 ? filtered : undefined;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleaned = stripEmpty(value);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  return obj;
}
