import { getDesiredDocument, getObservedDocument, getResourceRef } from '../core/resource.js';
import { Pending } from '../tracking/index.js';

import type { PipelineState } from './types.js';

/**
 * RESOLVE phase: walk dependency edges and replace Pending markers
 * with concrete values from observed state where available.
 *
 * For each resource's desired document, recursively find Pending values.
 * Look up the source resource's observed state at the source path.
 * If concrete → replace. If not available → leave Pending in place.
 */
export function resolve(state: PipelineState): PipelineState {
  // Build a lookup: resource id → Resource instance
  const resourceById = new Map(state.resources.map((r) => [getResourceRef(r).id, r]));

  for (const resource of state.resources) {
    const desired = getDesiredDocument(resource);
    resolvePending(desired, resourceById);
  }

  return state;
}

/**
 * Recursively walk an object and resolve any Pending markers.
 */
function resolvePending(
  obj: Record<string, unknown>,
  resourceById: ReadonlyMap<string, import('../core/resource.js').Resource>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (Pending.is(value)) {
      const sourceResource = resourceById.get(value.source.id);
      if (sourceResource) {
        const observed = getObservedDocument(sourceResource);
        const resolved = getNestedValue(observed, value.path);
        if (resolved !== undefined) {
          obj[key] = resolved;
        }
        // else: leave Pending in place — still unresolved
      }
    } else if (Array.isArray(value)) {
      resolveArray(value, resourceById);
    } else if (value !== null && typeof value === 'object') {
      resolvePending(value as Record<string, unknown>, resourceById);
    }
  }
}

function resolveArray(
  arr: unknown[],
  resourceById: ReadonlyMap<string, import('../core/resource.js').Resource>,
): void {
  for (let i = 0; i < arr.length; i++) {
    const value = arr[i];
    if (Pending.is(value)) {
      const sourceResource = resourceById.get(value.source.id);
      if (sourceResource) {
        const observed = getObservedDocument(sourceResource);
        const resolved = getNestedValue(observed, value.path);
        if (resolved !== undefined) {
          arr[i] = resolved;
        }
      }
    } else if (Array.isArray(value)) {
      resolveArray(value, resourceById);
    } else if (value !== null && typeof value === 'object') {
      resolvePending(value as Record<string, unknown>, resourceById);
    }
  }
}

/**
 * Get a nested value from an object by dot-separated path.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
