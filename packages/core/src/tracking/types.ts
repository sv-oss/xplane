/**
 * Symbols used to access tracking metadata on proxy-wrapped values.
 * These are not enumerable and won't leak into serialized output.
 */
export const TRACKING_META = Symbol.for('xplane.tracking.meta');
export const IS_TRACKED = Symbol.for('xplane.tracking.isTracked');

/** Identifies which resource a tracked value belongs to. */
export interface ResourceRef {
  readonly id: string;
}

/** A single dependency edge between two resource fields. */
export interface DependencyEdge {
  /** Resource whose field is being read (the dependency). */
  readonly from: ResourceRef;
  /** Dot-separated path on the source resource. */
  readonly fromPath: string;
  /** Resource whose field is being set (the dependent). */
  readonly to: ResourceRef;
  /** Dot-separated path on the target resource. */
  readonly toPath: string;
}

/** Metadata attached to every tracked proxy. */
export interface TrackingMeta {
  /** The resource this value belongs to. */
  readonly owner: ResourceRef;
  /** The dot-separated path from root of the resource object. */
  readonly path: string;
  /** Whether this value originates from observed state (read-only). */
  readonly observed: boolean;
}

/** Reference to an existing cluster resource requested via Crossplane's required resources mechanism. */
export interface ExistingResourceRef {
  /** API version of the resource (e.g. "example.io/v1"). */
  readonly apiVersion: string;
  /** Kind of the resource (e.g. "Project"). */
  readonly kind: string;
  /** Name of the resource. May be a raw string or a tracked proxy value (resolved later). */
  readonly name: unknown;
  /** Optional namespace of the resource. */
  readonly namespace?: string;
  /** Deterministic key for this reference (apiVersion/kind/[namespace/]name). */
  readonly refKey: string;
}
