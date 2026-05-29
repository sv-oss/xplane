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
import { PendingTemplate } from '../tracking/types.js';

import type { EmittedResource, PipelineState } from './types.js';

/**
 * EMIT phase: serialize each resource classified as 'emit' into a plain
 * Kubernetes resource document ready for Crossplane.
 *
 * Also extracts the XR desired status from this.xr.status assignments.
 */
export function emit(state: PipelineState): PipelineState {
  const emitted: EmittedResource[] = [];

  for (const resource of state.resources) {
    if (isExternal(resource)) continue;

    const ref = getResourceRef(resource);
    const classification = state.classification.get(ref.id);
    if (classification !== 'emit') continue;

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
  }

  // Extract XR status and resolve any ReadProxy values using observed data
  const resourceById = new Map(state.resources.map((r) => [getResourceRef(r).id, r]));
  const rawStatus = getXrDesiredStatus(state.composition);
  const xrStatusPatches = resolveXrStatus(rawStatus, resourceById);

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
  const toPrim = (proxy as Record<symbol, unknown>)[Symbol.toPrimitive];
  if (typeof toPrim === 'function') {
    const result = (toPrim as () => unknown)();
    if (result !== undefined && result !== null && typeof result !== 'object') {
      // Leaf proxy placeholders are not real values — skip them
      if (typeof result === 'string' && result.startsWith('__pending__')) return undefined;
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
