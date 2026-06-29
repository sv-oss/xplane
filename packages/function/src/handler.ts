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

import type {
  BlockedResource,
  CompositionInput,
  CompositionModule,
  CompositionResult,
} from '@xplane/core';

import type { CompositionLoader } from './loader/types.js';
import { isSyntheticUsageDoc } from './usage-status.js';

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
    try {
      return await this._run(req, logger);
    } catch (err) {
      // Last-resort safety net: the upstream FunctionRunner logs only `error.message`
      // (no stack), so any error escaping this handler loses its trace. Log the full
      // error here (Pino's default `err` serializer expands it to {type, message, stack})
      // and convert it into a fatal response so Crossplane still gets a valid reply.
      logger?.error({ err }, 'Composition handler failed');
      const rsp = to(req);
      fatal(rsp, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
      return rsp;
    }
  }

  private async _run(req: RunFunctionRequest, logger?: Logger): Promise<RunFunctionResponse> {
    let rsp = to(req);

    // Track iteration count via context key
    const [iterationCtxValue] = getContextKey(req, ITERATION_KEY);
    const iteration = typeof iterationCtxValue === 'number' ? iterationCtxValue + 1 : 1;
    setContextKey(rsp, ITERATION_KEY, iteration);

    // Load the composition module
    const rawInput = getInput(req) ?? {};
    let module: CompositionModule;
    try {
      module = await this._loader.load(rawInput as Record<string, unknown>, logger);
    } catch (err) {
      logger?.error({ err }, 'Failed to load composition');
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
      log?.error({ err }, 'Composition run threw');
      fatal(rsp, `Composition failed: ${err instanceof Error ? err.message : String(err)}`);
      return rsp;
    }

    const blockedResources = result.blockedResources ?? [];

    log?.info(
      {
        emitted: result.resources.map((r) => r.nodePath),
        blocked: blockedResources.map((b) => b.nodePath),
      },
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
      // Preserved resources are blocked but emitted as their observed state by the pipeline —
      // mark them READY_FALSE so the XR cannot be prematurely considered ready.
      if (resource.preserved) {
        sdkRes.ready = Ready.READY_FALSE;
      } else {
        sdkRes.ready = resource.ready ? Ready.READY_TRUE : Ready.READY_UNSPECIFIED;
      }
      desired[resource.nodePath] = sdkRes;
    }

    // Safety-net: for any blocked resources not already in desired (i.e. newly introduced
    // resources with no observed state yet), there is nothing to preserve — this loop is
    // effectively a no-op after the pipeline's own preservation logic above, but is kept
    // as a defensive fallback in case of unexpected gaps.
    const observedSdk = getObservedComposedResources(req) ?? {};
    for (const blocked of blockedResources) {
      const blockedKey = blocked.nodePath;
      if (desired[blockedKey]) continue; // already handled by the pipeline
      const observedRes = observedSdk[blockedKey];
      if (observedRes) {
        const doc = toObject(observedRes);
        if (doc) {
          const sdkRes = fromObject(doc as Record<string, unknown>);
          sdkRes.ready = Ready.READY_FALSE;
          desired[blockedKey] = sdkRes;
        }
      }
    }
    setDesiredComposedResources(rsp, desired);

    // Build the built-in `status.xplane` payload (opt-in). Writing this field
    // requires the XRD's openAPIV3Schema to declare `status.xplane`, so it's
    // off by default and enabled via `this.emitXplaneStatus = true` in the
    // composition constructor.
    const xrStatusWithXplane: Record<string, unknown> = result.emitXplaneStatus
      ? { ...result.xrStatus, xplane: buildXplaneStatus(result, blockedResources, observedSdk) }
      : { ...result.xrStatus };

    // Apply XR status patches. When resources are blocked/pending, inject a
    // Ready=False condition so Crossplane cannot prematurely mark the XR ready.
    const waitingCount = result.diagnostics.length + blockedResources.length;
    if (waitingCount > 0) {
      const existingConditions = Array.isArray(xrStatusWithXplane.conditions)
        ? (xrStatusWithXplane.conditions as unknown[]).filter(
            (c): c is Record<string, unknown> =>
              typeof c === 'object' &&
              c !== null &&
              (c as Record<string, unknown>).type !== 'Ready',
          )
        : [];
      const xrStatusWithReady = {
        ...xrStatusWithXplane,
        conditions: [
          ...existingConditions,
          {
            type: 'Ready',
            status: 'False',
            reason: 'Waiting',
            message: `Waiting for ${waitingCount} resource(s) to resolve`,
            lastTransitionTime: new Date().toISOString(),
          },
        ],
      };
      log?.debug({ xrStatus: xrStatusWithReady }, 'XR status patches (with Ready=False)');
      applyXrStatus(rsp, xrStatusWithReady);
    } else if (Object.keys(xrStatusWithXplane).length > 0) {
      log?.debug({ xrStatus: xrStatusWithXplane }, 'XR status patches');
      applyXrStatus(rsp, xrStatusWithXplane);
    }

    // Report diagnostics as XR conditions
    if (result.diagnostics.length > 0 || blockedResources.length > 0) {
      const diagMessages = result.diagnostics.map((d) => {
        if (d.reason === 'cycle') {
          return `Resource '${d.resource}' has a circular dependency: ${d.cycle?.join(' → ')}`;
        }
        if (d.reason === 'not-found') {
          return d.detail ?? `External resource '${d.resource}' was not found`;
        }
        if (d.reason === 'dependency' && d.waitingOn && d.waitingOn.length > 0) {
          return `Resource '${d.resource}' is waiting for ${d.waitingOn.map((id) => `'${id}'`).join(', ')} to be Ready`;
        }
        const deps = d.pendingPaths
          ?.map((p) => `'${p.waitingOn.resource}' to provide ${p.waitingOn.path}`)
          .join(', ');
        return `Resource '${d.resource}' is waiting for ${deps}`;
      });
      // Fall back to a summary of blocked resources when diagnose surfaced no
      // root causes (e.g. every blocker is downstream of another blocker).
      const messages =
        diagMessages.length > 0
          ? diagMessages
          : blockedResources.map((b) =>
              b.waitingFor && b.waitingFor.length > 0
                ? `Resource '${b.nodePath}' is waiting for ${b.waitingFor.join(', ')}`
                : `Resource '${b.nodePath}' is blocked`,
            );

      const message = messages.join('; ');
      log?.info(
        { diagnostics: result.diagnostics.length, blocked: blockedResources.length, iteration },
        'Resources blocked',
      );

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

/**
 * Build the built-in `status.xplane` payload: a compact, structured view of
 * what the pipeline emitted and what is still blocked, surfaced directly on
 * the XR for observability.
 */
function buildXplaneStatus(
  result: CompositionResult,
  blockedResources: BlockedResource[],
  observedSdk: Record<string, SdkResource>,
): {
  emittedResources: Array<{
    apiVersion: string;
    kind: string;
    nodePath: string;
    name?: string;
    namespace?: string;
    ready: boolean;
  }>;
  blockedResources: Array<{
    apiVersion: string;
    kind: string;
    nodePath: string;
    name?: string;
    namespace?: string;
    waitingFor?: string[];
  }>;
} {
  const emittedResources: Array<{
    apiVersion: string;
    kind: string;
    nodePath: string;
    name?: string;
    namespace?: string;
    ready: boolean;
  }> = [];
  for (const r of result.resources) {
    if (r.preserved) continue;
    if (!result.usageStatusVisible && isSyntheticUsageDoc(r.document)) continue;
    const doc = r.document;
    const apiVersion = typeof doc.apiVersion === 'string' ? doc.apiVersion : '';
    const kind = typeof doc.kind === 'string' ? doc.kind : '';
    const desiredMeta = readMetadata(doc);
    const observedMeta = readObservedMetadata(observedSdk[r.nodePath]);
    const k8sName = r.name ?? pickString(desiredMeta?.name) ?? pickString(observedMeta?.name);
    const namespace =
      r.namespace ?? pickString(desiredMeta?.namespace) ?? pickString(observedMeta?.namespace);
    emittedResources.push({
      apiVersion,
      kind,
      nodePath: r.nodePath,
      ...(k8sName ? { name: k8sName } : {}),
      ...(namespace ? { namespace } : {}),
      ready: r.ready === true,
    });
  }

  const blocked = blockedResources.map((b) => ({
    apiVersion: b.apiVersion,
    kind: b.kind,
    nodePath: b.nodePath,
    ...(b.name ? { name: b.name } : {}),
    ...(b.namespace ? { namespace: b.namespace } : {}),
    ...(b.waitingFor && b.waitingFor.length > 0 ? { waitingFor: b.waitingFor } : {}),
  }));

  return { emittedResources, blockedResources: blocked };
}

function readMetadata(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  return doc.metadata && typeof doc.metadata === 'object'
    ? (doc.metadata as Record<string, unknown>)
    : undefined;
}

function readObservedMetadata(res: SdkResource | undefined): Record<string, unknown> | undefined {
  if (!res) return undefined;
  const obj = toObject(res) as Record<string, unknown> | undefined;
  return obj ? readMetadata(obj) : undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
