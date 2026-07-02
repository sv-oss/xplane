import { createHash } from 'node:crypto';
import type { Resource } from '../core/resource.js';
import { getDesiredDocument, getObservedDocument, isExternal } from '../core/resource.js';
import type { EmittedResource, PipelineState } from '../pipeline/types.js';

import { SYNTHETIC_ANNOTATION_KEY, SYNTHETIC_USAGE_VALUE, USAGE_API_VERSION } from './options.js';

/** Minimal `{apiVersion, kind, name, namespace?}` ref shape. */
interface ObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/**
 * Build framework-synthesized Crossplane `Usage` / `ClusterUsage` documents
 * from the composition's dependency graph.
 *
 * Two data sources combine to form the full `(by, of)` pair set:
 *
 * 1. `composition.collector.edges` — the per-field `DependencyEdge` records
 *    produced when a desired field is assigned a `ReadProxy` value. These
 *    are the "implicit" edges, gated by
 *    `usageOptions.emitImplicitEdges`, and drive the "field-list" form of
 *    `spec.reason`.
 * 2. `state.graph.adjacency` — populated only by `addExplicitDependency`
 *    via `linkConstructDependencies`, capturing user-authored
 *    `node.addDependency()` calls (which do not push to the collector).
 *    These are the "explicit" edges, gated by
 *    `usageOptions.emitExplicitEdges`.
 *
 * Pairs that only appear in (2) get the "explicitly depends on" reason form.
 * A pair contributed by both sources is emitted when at least one of the
 * enabled flags matches; the reason keeps the field-list form so no
 * information is lost.
 *
 * Scope is decided from the dependent's observed metadata: if it has a
 * namespace, emit a namespaced `Usage`; otherwise emit a cluster-scoped
 * `ClusterUsage`. Emission is deferred until the dependent has an observed
 * document so that Crossplane has had a chance to apply XR-inherited
 * namespace defaults — emitting before that would risk choosing the wrong
 * scope.
 */
export function buildUsageResources(state: PipelineState): EmittedResource[] {
  const opts = state.composition.compositionOptions;
  const { emitImplicitEdges, emitExplicitEdges } = opts.usageOptions;
  if (!emitImplicitEdges && !emitExplicitEdges) return [];

  const resourcesById = indexResources(state.resources);
  const pairs = collectPairs(
    state,
    resourcesById,
    opts.usageOptions.includeExternal,
    emitImplicitEdges,
    emitExplicitEdges,
  );

  const out: EmittedResource[] = [];
  for (const pair of pairs) {
    const doc = buildUsageDocument(pair, opts.usageOptions.replayDeletion);
    out.push({
      name: `__usage/${pair.docName}`,
      document: doc,
      autoReady: false,
      readyChecks: [],
    });
  }
  return out;
}

interface CollapsedPair {
  byRef: ObjectRef;
  ofRef: ObjectRef;
  byId: string;
  ofId: string;
  paths: string[];
  scope: 'namespaced' | 'cluster';
  docName: string;
}

function indexResources(resources: ReadonlyArray<Resource>): Map<string, Resource> {
  const out = new Map<string, Resource>();
  for (const r of resources) {
    out.set(r.node.path, r);
  }
  return out;
}

/**
 * Walk both data sources (collector edges + graph adjacency) to derive
 * `(by, of)` pairs, enrich with field-level path info, and filter out pairs
 * that cannot be emitted this reconcile or whose only contributing edge
 * kind is disabled via `emitImplicitEdges` / `emitExplicitEdges`.
 */
function collectPairs(
  state: PipelineState,
  resourcesById: ReadonlyMap<string, Resource>,
  includeExternal: boolean,
  emitImplicitEdges: boolean,
  emitExplicitEdges: boolean,
): CollapsedPair[] {
  // Merge: pair key → { paths, hasImplicit, hasExplicit }.
  interface PairAccumulator {
    byId: string;
    ofId: string;
    paths: Set<string>;
    hasImplicit: boolean;
    hasExplicit: boolean;
  }
  const acc = new Map<string, PairAccumulator>();

  const getOrCreate = (byId: string, ofId: string): PairAccumulator | undefined => {
    if (byId === ofId) return undefined;
    const key = `${byId}\u0000${ofId}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = { byId, ofId, paths: new Set<string>(), hasImplicit: false, hasExplicit: false };
      acc.set(key, entry);
    }
    return entry;
  };

  // Field-level (implicit) edges from the EdgeCollector. The collector models
  // edges as `from = source (observed, of)` and `to = target (desired, by)`.
  for (const edge of state.composition.collector.edges) {
    const entry = getOrCreate(edge.to.id, edge.from.id);
    if (!entry) continue;
    entry.hasImplicit = true;
    entry.paths.add(edge.fromPath);
  }

  // Construct-level (explicit) dependencies — node.addDependency.
  for (const byId of state.graph.resourceIds) {
    for (const ofId of state.graph.getDependencies(byId)) {
      const entry = getOrCreate(byId, ofId);
      if (!entry) continue;
      entry.hasExplicit = true;
    }
  }

  const pairs: CollapsedPair[] = [];
  for (const entry of acc.values()) {
    const enabled =
      (entry.hasImplicit && emitImplicitEdges) || (entry.hasExplicit && emitExplicitEdges);
    if (!enabled) continue;
    const built = buildPair(
      state,
      resourcesById,
      entry.byId,
      entry.ofId,
      entry.paths,
      includeExternal,
    );
    if (built) pairs.push(built);
  }
  return pairs;
}

function buildPair(
  state: PipelineState,
  resourcesById: ReadonlyMap<string, Resource>,
  byId: string,
  ofId: string,
  paths: ReadonlySet<string>,
  includeExternal: boolean,
): CollapsedPair | undefined {
  const byResource = resourcesById.get(byId);
  if (!byResource) return undefined;
  if (isExternal(byResource)) return undefined;

  const classification = state.classification.get(byId);
  if (classification !== 'emit' && classification !== 'blocked') return undefined;

  const byObserved = getObservedDocument(byResource);
  if (Object.keys(byObserved).length === 0) return undefined;

  const byRef = deriveObjectRef(byResource);
  if (!byRef) return undefined;

  const ofResource = resourcesById.get(ofId);
  if (!ofResource) return undefined;
  if (isExternal(ofResource) && !includeExternal) return undefined;

  const ofRef = deriveObjectRef(ofResource);
  if (!ofRef) return undefined;

  return {
    byId,
    ofId,
    byRef,
    ofRef,
    paths: [...paths].sort(),
    scope: byRef.namespace ? 'namespaced' : 'cluster',
    docName: usageResourceName(byId, ofId),
  };
}

/**
 * Derive a `{apiVersion, kind, name, namespace?}` ref for the given Resource,
 * preferring observed metadata (Crossplane fills in inherited namespaces and
 * provider-generated names there) and falling back to desired.
 */
export function deriveObjectRef(resource: Resource): ObjectRef | undefined {
  const observed = getObservedDocument(resource);
  const desired = getDesiredDocument(resource);

  const apiVersion = pickString(observed.apiVersion) ?? pickString(desired.apiVersion);
  const kind = pickString(observed.kind) ?? pickString(desired.kind);
  if (!apiVersion || !kind) return undefined;

  const observedMeta = readMetadata(observed);
  const desiredMeta = readMetadata(desired);
  const name = pickString(observedMeta?.name) ?? pickString(desiredMeta?.name);
  if (!name) return undefined;

  const namespace = pickString(observedMeta?.namespace) ?? pickString(desiredMeta?.namespace);
  return namespace ? { apiVersion, kind, name, namespace } : { apiVersion, kind, name };
}

function readMetadata(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = doc.metadata;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Compile a deterministic `metadata.generateName` value for the synthesized
 * Usage doc. The trailing hyphen lets Kubernetes append a unique 5-character
 * suffix per XR so multiple composites in the same namespace do not collide.
 * Sanitizes both ids to RFC 1123 (lowercase alphanumeric + hyphens) and falls
 * back to a content hash when the joined result would exceed the 248-char
 * budget that leaves room for the suffix.
 */
export function usageResourceName(byId: string, ofId: string): string {
  const left = sanitize(byId);
  const right = sanitize(ofId);
  const joined = `${left}--uses--${right}-`;
  // 253 (k8s name limit) - 5 (generated suffix) = 248 chars max for generateName.
  if (joined.length <= 248) return joined;

  const hash = createHash('sha256').update(`${byId}\u0000${ofId}`).digest('hex').slice(0, 8);
  const budget = 248 - hash.length - 2; // hash + hyphen before hash + trailing hyphen
  return `${joined.slice(0, budget)}-${hash}-`;
}

function sanitize(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/** Compile the human-readable `spec.reason` string for a Usage doc. */
export function buildUsageReason(
  by: ObjectRef,
  of: ObjectRef,
  paths: ReadonlyArray<string>,
): string {
  if (paths.length === 0) {
    return `xplane: ${by.kind}/${by.name} explicitly depends on ${of.kind}/${of.name}`;
  }
  return `xplane: ${by.kind}/${by.name} needs ${of.kind}/${of.name} fields [${paths.join(', ')}]`;
}

function buildUsageDocument(pair: CollapsedPair, replayDeletion: boolean): Record<string, unknown> {
  const kind = pair.scope === 'namespaced' ? 'Usage' : 'ClusterUsage';
  const reason = buildUsageReason(pair.byRef, pair.ofRef, pair.paths);

  const metadata: Record<string, unknown> = {
    generateName: pair.docName,
    annotations: { [SYNTHETIC_ANNOTATION_KEY]: SYNTHETIC_USAGE_VALUE },
  };
  if (pair.scope === 'namespaced' && pair.byRef.namespace) {
    metadata.namespace = pair.byRef.namespace;
  }

  const spec: Record<string, unknown> = {
    of: refToSpec(pair.ofRef),
    by: refToSpec(pair.byRef),
    reason,
  };
  if (replayDeletion) {
    spec.replayDeletion = true;
  }

  return {
    apiVersion: USAGE_API_VERSION,
    kind,
    metadata,
    spec,
  };
}

function refToSpec(ref: ObjectRef): Record<string, unknown> {
  return {
    apiVersion: ref.apiVersion,
    kind: ref.kind,
    resourceRef: { name: ref.name },
  };
}
