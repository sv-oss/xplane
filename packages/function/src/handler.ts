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
  getRequiredResources,
  normal,
  Ready,
  requireResource,
  setContextKey,
  setDesiredComposedResources,
  to,
  toObject,
} from '@crossplane-org/function-sdk-typescript';

import type { CompositionInput, CompositionModule, CompositionResult } from '@xplane/core';

import type { CompositionLoader } from './loader/types.js';

/** Context key for tracking iteration count across invocations. */
const ITERATION_KEY = 'xplane.function.iteration';

/** Maximum number of iterations before signalling fatal. */
const MAX_ITERATIONS = 5;

/**
 * Crossplane FunctionHandler — thin I/O adapter between the SDK wire format
 * and the composition module's `run()` function.
 *
 * This handler has zero knowledge of framework internals (no WeakMaps,
 * no internal accessors, no AsyncLocalStorage). It only:
 * 1. Extracts CompositionInput from the Crossplane request
 * 2. Calls module.run(input)
 * 3. Maps CompositionResult to the Crossplane response
 */
export class CompositionHandler implements FunctionHandler {
  private readonly _loader: CompositionLoader;

  constructor(loader: CompositionLoader) {
    this._loader = loader;
  }

  async RunFunction(req: RunFunctionRequest, logger?: Logger): Promise<RunFunctionResponse> {
    let rsp = to(req);

    // Track iteration count via context key
    const [iterationCtxValue] = getContextKey(req, ITERATION_KEY);
    const iteration = typeof iterationCtxValue === 'number' ? iterationCtxValue + 1 : 1;
    setContextKey(rsp, ITERATION_KEY, iteration);

    // Load the composition module
    const rawInput = getInput(req) ?? {};
    let module: CompositionModule;
    try {
      module = await this._loader.load(rawInput as Record<string, unknown>);
    } catch (err) {
      fatal(rsp, `Failed to load composition: ${err instanceof Error ? err.message : String(err)}`);
      return rsp;
    }

    // Extract CompositionInput from the Crossplane request
    const input = extractInput(req);

    const log = logger?.child(xrIdentity(input.xr));
    log?.info({ iteration, loader: this._loader.name }, 'Running composition');

    // Run the composition — pure data in, pure data out
    let result: CompositionResult;
    try {
      result = module.run(input);
    } catch (err) {
      fatal(rsp, `Composition failed: ${err instanceof Error ? err.message : String(err)}`);
      return rsp;
    }

    log?.info(
      { emitted: result.resources.map((r) => r.name), blocked: result.diagnostics.length },
      'Pipeline completed',
    );

    // Emit requireResource requests for external resources
    for (const ext of result.externalResources) {
      log?.debug(
        { refKey: ext.refKey, matchName: ext.name, namespace: ext.namespace },
        'Requiring external resource',
      );
      rsp = requireResource(rsp, ext.refKey, {
        apiVersion: ext.apiVersion,
        kind: ext.kind,
        matchName: ext.name,
        ...(ext.namespace ? { namespace: ext.namespace } : {}),
      });
    }

    // Build desired composed resources
    const desired: Record<string, SdkResource> = getDesiredComposedResources(req) ?? {};
    for (const resource of result.resources) {
      const sdkRes = fromObject(resource.document);
      sdkRes.ready = resource.ready ? Ready.READY_TRUE : Ready.READY_UNSPECIFIED;
      desired[resource.name] = sdkRes;
    }
    setDesiredComposedResources(rsp, desired);

    // Apply XR status patches
    if (Object.keys(result.xrStatus).length > 0) {
      log?.debug({ xrStatus: result.xrStatus }, 'XR status patches');
      applyXrStatus(rsp, result.xrStatus);
    }

    // Report diagnostics as XR conditions
    if (result.diagnostics.length > 0) {
      const messages = result.diagnostics.map((d) => {
        if (d.reason === 'cycle') {
          return `Resource '${d.resource}' has a circular dependency: ${d.cycle?.join(' → ')}`;
        }
        if (d.reason === 'not-found') {
          return d.detail ?? `External resource '${d.resource}' was not found`;
        }
        const deps = d.pendingPaths
          ?.map((p) => `'${p.waitingOn.resource}' to provide ${p.waitingOn.path}`)
          .join(', ');
        return `Resource '${d.resource}' is waiting for ${deps}`;
      });

      const message = messages.join('; ');
      log?.info({ diagnostics: result.diagnostics.length, iteration }, 'Resources blocked');

      if (iteration >= MAX_ITERATIONS) {
        fatal(rsp, `Max iterations (${MAX_ITERATIONS}) reached: ${message}`);
      } else {
        normal(rsp, `Waiting for external resources (iteration ${iteration}): ${message}`);
      }
    } else {
      normal(rsp, 'Composition rendered successfully');
    }

    return rsp;
  }
}

/**
 * Extract CompositionInput from a RunFunctionRequest.
 */
function extractInput(req: RunFunctionRequest): CompositionInput {
  // Observed XR
  const observedXR = getObservedCompositeResource(req);
  const xr: Record<string, unknown> = observedXR
    ? ((toObject(observedXR) as Record<string, unknown>) ?? { spec: {}, status: {} })
    : { spec: {}, status: {} };

  // Pipeline context
  const pipelineContext: Record<string, unknown> = {};
  if (req.context) {
    for (const [key, value] of Object.entries(req.context)) {
      pipelineContext[key] = value;
    }
  }

  // Observed required (existing) resources
  const observedRequired: Record<string, Record<string, unknown>> = {};
  for (const [refKey, resolved] of Object.entries(getRequiredResources(req))) {
    if (resolved?.items.length) {
      const obj = toObject(resolved.items[0]!);
      if (obj) observedRequired[refKey] = obj as Record<string, unknown>;
    }
  }

  // Observed composed resources (keyed by full construct path)
  const observedComposed: Record<string, Record<string, unknown>> = {};
  const observedSdk = getObservedComposedResources(req);
  if (observedSdk) {
    for (const [name, res] of Object.entries(observedSdk)) {
      const obj = toObject(res);
      if (obj) observedComposed[`Composition/${name}`] = obj as Record<string, unknown>;
    }
  }

  return { xr, pipelineContext, observedComposed, observedRequired };
}

function xrIdentity(xr: Record<string, unknown>): Record<string, string> {
  const meta = (xr.metadata ?? {}) as Record<string, string>;
  return {
    xr: `${xr.apiVersion ?? '?'}/${xr.kind ?? '?'}`,
    xrName: meta.name ?? '?',
    ...(meta.namespace ? { xrNamespace: meta.namespace } : {}),
  };
}

/**
 * Directly set status fields on the desired composite.
 */
function applyXrStatus(rsp: RunFunctionResponse, status: Record<string, unknown>): void {
  if (!rsp.desired) {
    rsp.desired = { composite: undefined, resources: {} };
  }
  if (!rsp.desired.composite) {
    rsp.desired.composite = fromObject({ apiVersion: '', kind: '' });
  }
  if (!rsp.desired.composite.resource) {
    rsp.desired.composite.resource = {};
  }
  rsp.desired.composite.resource.status = status;
}
