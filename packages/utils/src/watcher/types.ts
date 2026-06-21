import type { KubernetesObject } from '@kubernetes/client-node';

/**
 * Reference to a single Crossplane Composite Resource (XR) the watcher should track.
 */
export interface XrRef {
  /** API group, e.g. `platform.example.com`. Empty string for the core group. */
  group: string;
  /** API version, e.g. `v1alpha1`. */
  version: string;
  /** Resource plural, e.g. `xprojects`. */
  plural: string;
  /** Resource kind, e.g. `XProject`. */
  kind: string;
  /** Whether the resource is namespaced. */
  namespaced: boolean;
  /** Object name. */
  name: string;
  /** Namespace; required when `namespaced` is true. */
  namespace?: string;
}

/** A composed resource entry as published in `status.xplane.emittedResources`. */
export interface EmittedResource {
  apiVersion: string;
  kind: string;
  /** Construct path within the composition (also the Crossplane composed-resource key). */
  nodePath: string;
  /** Kubernetes `metadata.name`, when known. */
  name?: string;
  /** Kubernetes `metadata.namespace`, when present. */
  namespace?: string;
  ready: boolean;
}

/** A blocked resource entry as published in `status.xplane.blockedResources`. */
export interface BlockedResource {
  apiVersion: string;
  kind: string;
  /** Construct path within the composition (also the Crossplane composed-resource key). */
  nodePath: string;
  /** Kubernetes `metadata.name`, when known. */
  name?: string;
  /** Kubernetes `metadata.namespace`, when present. */
  namespace?: string;
  waitingFor?: string[];
}

/** The compact observability payload set on the XR when `emitXplaneStatus = true`. */
export interface XplaneStatus {
  emittedResources: EmittedResource[];
  blockedResources: BlockedResource[];
}

/** A `spec.resourceRefs` / `status.resourceRefs` entry on a Crossplane XR. */
export interface ResourceRef {
  apiVersion: string;
  kind: string;
  name: string;
}

/** Snapshot of an XR's state as observed by the watcher. */
export interface XrSnapshot {
  /** The full XR object from the API server. */
  object: KubernetesObject;
  /** True when a `Ready` condition with `status: "True"` is present. */
  ready: boolean;
  /** Reason of the `Ready` condition, if any. */
  readyReason?: string;
  /** Message of the `Ready` condition, if any. */
  readyMessage?: string;
  /** True when a `Responsive` condition reports `status: "False"` with reason `WatchCircuitOpen`. */
  updatesThrottled?: boolean;
  /** Present when the `Synced` condition is `status: "False"` with reason `ReconcileError` — a fatal reconcile failure. */
  syncError?: { reason: string; message: string };
  /** Parsed `status.xplane` payload, if present. */
  xplane?: XplaneStatus;
  /** Parsed `status.resourceRefs` (composed resources). */
  resourceRefs: ResourceRef[];
}

/** A condensed view of a Kubernetes Event tied to the watched XR. */
export interface KubernetesEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  involvedKind?: string;
  involvedName?: string;
}

/** Stream item emitted by the XR watcher. */
export type XrEvent =
  | { type: 'snapshot'; snapshot: XrSnapshot }
  | { type: 'k8s-event'; event: KubernetesEvent }
  | { type: 'ready'; snapshot: XrSnapshot }
  | { type: 'error'; error: Error }
  | { type: 'end' };
