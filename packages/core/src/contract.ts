/**
 * Contract types defining the boundary between the runtime (@xplane/function)
 * and the framework (@xplane/core).
 *
 * The runtime provides CompositionInput (plain data extracted from Crossplane),
 * the framework returns CompositionResult (plain serializable data).
 * No class instances, no WeakMaps, no shared state crosses this boundary.
 */

// ─── Input ────────────────────────────────────────────────────────────────────

/**
 * Plain data input provided by the runtime to the composition.
 * All values are serializable Records — no class instances.
 */
export interface CompositionInput {
  /** Observed XR data (spec, status, metadata). */
  xr: Record<string, unknown>;
  /** Crossplane function pipeline context keys. */
  pipelineContext: Record<string, unknown>;
  /** Observed composed resources, keyed by resource name (e.g. "Composition/vpc"). */
  observedComposed: Record<string, Record<string, unknown>>;
  /** Observed existing/required resources, keyed by refKey. */
  observedRequired: Record<string, Record<string, unknown>>;
}

// ─── Output ───────────────────────────────────────────────────────────────────

/**
 * Plain data output returned by the composition to the runtime.
 * Fully serializable — no class instances, proxies, or internal state.
 */
export interface CompositionResult {
  /** Resources to emit to Crossplane as desired composed resources. */
  resources: DesiredResource[];
  /**
   * Resources that are blocked (pending resolution). The handler uses these
   * to preserve any previously-observed documents in desired state (preventing
   * accidental deletion), to prevent premature XR readiness, and to populate
   * `status.xplane.blockedResources` on the XR.
   */
  blockedResources: BlockedResource[];
  /** External resources that need to be fetched via requireResource. */
  externalResources: ExternalResourceRequest[];
  /** Desired XR status patches (from this.xr.status assignments). */
  xrStatus: Record<string, unknown>;
  /** Diagnostic reports for blocked/unresolved resources. */
  diagnostics: Diagnostic[];
  /**
   * When `true`, the runtime should inject a structured `status.xplane`
   * payload on the XR. Controlled by `Composition.emitXplaneStatus`.
   */
  emitXplaneStatus: boolean;
}

/** A desired composed resource ready for emission. */
export interface DesiredResource {
  /**
   * The construct path (without the `Composition/` prefix). This doubles as the
   * Crossplane composed-resource key in the function-pipeline desired map and
   * uniquely identifies the resource within the composition.
   */
  nodePath: string;
  /**
   * The actual Kubernetes `metadata.name` of the resolved document, when known.
   * May be undefined if the name is provider-generated or not yet resolved.
   */
  name?: string;
  /** The Kubernetes `metadata.namespace` of the document, when present. */
  namespace?: string;
  /** The fully-resolved desired Kubernetes resource document. */
  document: Record<string, unknown>;
  /** Whether this resource is ready (readiness already evaluated). */
  ready: boolean;
  /**
   * True when this resource is blocked (pending dependencies) and is being emitted
   * as its previously-observed state to prevent Crossplane from deleting it.
   * The handler must mark it as READY_FALSE and must not evaluate readiness.
   */
  preserved?: boolean;
}

/** A request to fetch an external (existing) resource. */
export interface ExternalResourceRequest {
  /** The refKey used to match the resource. */
  refKey: string;
  apiVersion: string;
  kind: string;
  /** The name to match. */
  name: string;
  /** Optional namespace. */
  namespace?: string;
}

/**
 * A blocked composed resource. Surfaced on the XR as
 * `status.xplane.blockedResources` for visibility.
 */
export interface BlockedResource {
  /** Construct path (also used as the Crossplane composed resource key). */
  nodePath: string;
  /** The actual Kubernetes `metadata.name` of the resolved document, when known. */
  name?: string;
  /** The Kubernetes `metadata.namespace` of the document, when present. */
  namespace?: string;
  /** The desired resource's apiVersion. */
  apiVersion: string;
  /** The desired resource's kind. */
  kind: string;
  /** Human-readable list of things this resource is waiting for. */
  waitingFor?: string[];
}

/** A diagnostic report for a blocked resource. */
export interface Diagnostic {
  /** The resource name (construct path). */
  resource: string;
  /** Why the resource is blocked. */
  reason: 'pending' | 'cycle' | 'not-found' | 'dependency';
  /** For 'pending': what paths are waiting on what. */
  pendingPaths?: Array<{
    path: string;
    waitingOn: { resource: string; path: string };
  }>;
  /** For 'cycle': the cycle path. */
  cycle?: string[];
  /** For 'dependency': the dependency target ids being awaited. */
  waitingOn?: string[];
  /** Human-readable detail. */
  detail?: string;
}

// ─── Composition Module ───────────────────────────────────────────────────────

/**
 * The shape of what a composition bundle must export.
 * Both full bundles and thin bundles export this.
 */
export interface CompositionModule {
  run(input: CompositionInput): CompositionResult;
}
