import { getXrDesiredStatus } from '../core/composition.js';
import {
  getDesiredDocument,
  getObservedDocument,
  getReadyChecks,
  getResourceInternals,
  getResourceRef,
  isExternal,
} from '../core/resource.js';
import { getReadProxyMeta, isReadProxy } from '../tracking/index.js';
import { Pending, PendingMerge, PendingTemplate } from '../tracking/types.js';
import { buildUsageResources } from '../usage/index.js';

import type { EmittedResource, PipelineState } from './types.js';

/**
 * EMIT phase: serialize each resource classified as 'emit' into a plain
 * Kubernetes resource document ready for Crossplane.
 *
 * Also extracts the XR desired status from this.xr.status assignments.
 *
 * For resources classified as 'blocked' that have previously-observed state,
 * emits the observed document as-is (marked `preserved: true`) so that
 * Crossplane does not delete them while their dependencies are still resolving.
 */
export function emit(state: PipelineState): PipelineState {
  const emitted: EmittedResource[] = [];

  for (const resource of state.resources) {
    if (isExternal(resource)) continue;

    const ref = getResourceRef(resource);
    const classification = state.classification.get(ref.id);

    if (classification === 'emit') {
      const internal = getResourceInternals(resource);
      const desired = getDesiredDocument(resource);

      // Strip the construct path prefix to get the resource name
      // The name is the full construct path minus the root "Composition/" prefix
      const name = ref.id.startsWith('Composition/') ? ref.id.slice('Composition/'.length) : ref.id;

      emitted.push({
        name,
        document: deepClean(desired),
        autoReady: internal.config.autoReady,
        readyChecks: getReadyChecks(resource),
      });
    } else if (classification === 'blocked') {
      // If this resource has been observed before (i.e. Crossplane already created it),
      // emit the observed document stripped of server-managed fields so Crossplane does
      // not delete it while its dependencies are still pending.
      const observed = getObservedDocument(resource);
      if (Object.keys(observed).length === 0) continue;

      const name = ref.id.startsWith('Composition/') ? ref.id.slice('Composition/'.length) : ref.id;

      emitted.push({
        name,
        document: stripServerFields(deepClean(observed)),
        autoReady: false,
        readyChecks: [],
        preserved: true,
      });
    }
  }

  // Extract XR status and resolve any ReadProxy values using observed data
  const resourceById = new Map(state.resources.map((r) => [getResourceRef(r).id, r]));
  const rawStatus = getXrDesiredStatus(state.composition);
  const xrStatusPatches = resolveXrStatus(rawStatus, resourceById);

  // Synthesize Crossplane Usage/ClusterUsage docs for tracked dependency edges
  // (gated by `composition.compositionOptions.usageOptions.emitImplicitEdges`
  // and `emitExplicitEdges`).
  emitted.push(...buildUsageResources(state));

  return { ...state, emitted, xrStatusPatches };
}

/**
 * Deep-clone an object, stripping any remaining framework internals.
 * This produces a clean JSON-serializable Kubernetes document.
 */
function deepClean(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = cleanValue(value);
  }

  return result;
}

function cleanValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (PendingTemplate.is(value)) {
    // Should never reach emit — indicates a bug in the pipeline
    throw new Error(
      `PendingTemplate reached emit phase — resource should have been classified as blocked. Parts: ${JSON.stringify(value.parts)}`,
    );
  }

  if (PendingMerge.is(value)) {
    // Should never reach emit — an unresolved PendingMerge blocks the resource.
    throw new Error(
      `PendingMerge reached emit phase — resource should have been classified as blocked. ` +
        `Waiting on '${value.source.id}' at '${value.path}'.`,
    );
  }

  if (Array.isArray(value)) {
    return value.map(cleanValue);
  }

  // Plain objects — recurse
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = cleanValue(val);
  }
  return result;
}

/**
 * Strip server-managed Kubernetes fields from an observed document before
 * emitting it as a preserved desired resource.
 *
 * These fields are set by the API server / controllers and must not appear
 * in the desired state — including them causes Crossplane to try propagating
 * them (e.g. `uid`) into XR resourceRefs fields that the XRD schema may not
 * declare, resulting in a typed-patch validation failure.
 */
const SERVER_MANAGED_METADATA = new Set([
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'managedFields',
  'ownerReferences',
  'selfLink',
]);

function stripServerFields(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...doc };

  // Remove top-level status — it is managed by the controller, not desired state
  delete result.status;

  // Strip server-managed metadata sub-fields
  if (result.metadata && typeof result.metadata === 'object') {
    const meta = { ...(result.metadata as Record<string, unknown>) };
    for (const field of SERVER_MANAGED_METADATA) {
      delete meta[field];
    }
    result.metadata = meta;
  }

  return result;
}

/**
 * Resolve ReadProxy values in XR status using observed resource data.
 * This is needed because XR status is written at construction time (before hydration),
 * so read proxy references need to be resolved post-hydration.
 */
function resolveXrStatus(
  status: Record<string, unknown>,
  resourceById: ReadonlyMap<string, import('../core/resource.js').Resource>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(status)) {
    const resolved = resolveStatusValue(value, resourceById);
    if (resolved !== undefined) {
      result[key] = resolved;
    }
  }
  return result;
}

function resolveStatusValue(
  value: unknown,
  resourceById: ReadonlyMap<string, import('../core/resource.js').Resource>,
): unknown {
  if (value === null || value === undefined) return undefined;

  if (isReadProxy(value)) {
    const meta = getReadProxyMeta(value);
    if (!meta) return undefined;

    // Try to extract a concrete primitive (already resolved read proxy)
    const prim = tryExtractPrimitive(value as object);
    if (prim !== undefined) return prim;

    // Leaf proxy — try to resolve from observed data
    const resource = resourceById.get(meta.owner.id);
    if (!resource) return undefined;
    const observed = getObservedDocument(resource);
    return getNestedValue(observed, meta.path);
  }

  // Pending marker captured at write time when a ReadProxy was assigned
  // directly (not via a template literal). Resolve from observed data.
  if (Pending.is(value)) {
    const resource = resourceById.get(value.source.id);
    if (!resource) return undefined;
    const observed = getObservedDocument(resource);
    const v = getNestedValue(observed, value.path);
    return v === null ? undefined : v;
  }

  // Template literal with unresolved slots captured at write time. Resolve
  // each slot from observed data now; render only when every slot is filled,
  // otherwise omit the field so we never emit a partially-resolved string.
  if (PendingTemplate.is(value)) {
    const resolvedSlots: string[] = [];
    for (const slot of value.slots) {
      const resource = resourceById.get(slot.source.id);
      if (!resource) return undefined;
      const observed = getObservedDocument(resource);
      const v = getNestedValue(observed, slot.path);
      if (v === undefined || v === null) return undefined;
      resolvedSlots.push(String(v));
    }
    let out = value.parts[0] ?? '';
    for (let i = 0; i < resolvedSlots.length; i++) {
      out += resolvedSlots[i] + (value.parts[i + 1] ?? '');
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveStatusValue(v, resourceById)).filter((v) => v != null);
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const resolved = resolveStatusValue(v, resourceById);
      if (resolved !== undefined) {
        out[k] = resolved;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return value;
}

function tryExtractPrimitive(proxy: object): string | number | boolean | undefined {
  const valueOfFn = (proxy as { valueOf?: () => unknown }).valueOf;
  if (typeof valueOfFn === 'function') {
    const result = valueOfFn.call(proxy);
    if (result !== undefined && result !== null && typeof result !== 'object') {
      return result as string | number | boolean;
    }
  }
  return undefined;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
