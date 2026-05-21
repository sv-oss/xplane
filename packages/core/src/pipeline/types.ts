import type { Composition } from '../core/composition.js';
import type { Resource } from '../core/resource.js';
import type { ReadyCheck } from '../readiness/index.js';
import type { DependencyGraph } from '../tracking/index.js';

// ─── Pipeline State ───────────────────────────────────────────────────────────

export interface PipelineState {
  /** The fully-constructed Composition instance. */
  composition: Composition;
  /** All resources in the composition tree (including external). */
  resources: Resource[];
  /** The dependency graph. */
  graph: DependencyGraph;
  /** Observed composed resources from Crossplane (keyed by resource name). */
  observedComposed: ReadonlyMap<string, Record<string, unknown>>;
  /** Observed existing/required resources from Crossplane (keyed by refKey). */
  observedRequired: ReadonlyMap<string, Record<string, unknown>>;
  /** Classification of resources after sequencing. */
  classification: Map<string, ResourceClassification>;
  /** Diagnostics produced by the diagnose phase. */
  diagnostics: DiagnosticReport[];
  /** Emitted desired resources (final output). */
  emitted: EmittedResource[];
  /** Desired XR status patches (from this.xr.status assignments). */
  xrStatusPatches: Record<string, unknown>;
}

export type ResourceClassification = 'emit' | 'blocked' | 'external';

export interface DiagnosticReport {
  resource: string;
  reason: 'pending' | 'cycle' | 'not-found';
  pendingPaths?: Array<{
    path: string;
    waitingOn: { resource: string; path: string };
  }>;
  cycle?: string[];
  detail?: string;
}

export interface EmittedResource {
  /** The construct path (used as resource name in Crossplane). */
  name: string;
  /** The desired Kubernetes resource document. */
  document: Record<string, unknown>;
  /** Whether autoReady was enabled for this resource. */
  autoReady: boolean;
  /** Custom readiness checks registered by the composition author. */
  readyChecks: ReadyCheck[];
}
