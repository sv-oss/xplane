import { getDesiredDocument, getObservedDocument, getResourceRef } from '../core/resource.js';
import { Pending, PendingMerge, PendingTemplate } from '../tracking/index.js';

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
    } else if (PendingMerge.is(value)) {
      const resolved = resolvePendingMerge(value, resourceById);
      if (resolved !== undefined) obj[key] = resolved;
      // else: leave PendingMerge in place — base still unresolved
    } else if (PendingTemplate.is(value)) {
      const resolved = resolvePendingTemplate(value, resourceById);
      if (resolved !== undefined) obj[key] = resolved;
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
    } else if (PendingMerge.is(value)) {
      const resolved = resolvePendingMerge(value, resourceById);
      if (resolved !== undefined) arr[i] = resolved;
    } else if (PendingTemplate.is(value)) {
      const resolved = resolvePendingTemplate(value, resourceById);
      if (resolved !== undefined) arr[i] = resolved;
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

/**
 * Resolve a {@link PendingMerge}: clone the referenced base object and deep-merge
 * the local overrides on top (overrides win).
 *
 * - Base resolves to a plain object → return the merged object.
 * - Base resolves to a primitive or array → throw (no child fields to merge into).
 * - Base is not yet observed → return `undefined` so the node stays pending and
 *   the resource remains blocked.
 */
function resolvePendingMerge(
  merge: PendingMerge,
  resourceById: ReadonlyMap<string, import('../core/resource.js').Resource>,
): unknown {
  const sourceResource = resourceById.get(merge.source.id);
  if (!sourceResource) return undefined;

  const observed = getObservedDocument(sourceResource);
  const base = getNestedValue(observed, merge.path);
  if (base === undefined || base === null) return undefined;

  if (typeof base !== 'object' || Array.isArray(base)) {
    const kind = Array.isArray(base) ? 'an array' : `a ${typeof base}`;
    throw new Error(
      `Cannot merge fields into '${merge.path}' of resource '${merge.source.id}': ` +
        `the referenced value resolved to ${kind}, which has no child fields.`,
    );
  }

  // Resolve any nested pending markers within the overrides first, then merge
  // the (possibly still-pending) overrides on top of a clone of the base.
  resolvePending(merge.overrides, resourceById);
  return deepMerge(deepClone(base as Record<string, unknown>), merge.overrides);
}

/**
 * Deep-merge `overrides` onto `base`, mutating and returning `base`.
 * Plain-object values are merged recursively; all other values (primitives,
 * arrays, and pending markers) from `overrides` replace the base value.
 */
function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(overrides)) {
    const existing = base[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      base[key] = deepMerge(existing, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Pending.is(value) &&
    !PendingMerge.is(value) &&
    !PendingTemplate.is(value)
  );
}

/**
 * Deep-clone plain observed data (JSON-safe by construction) so merges never
 * mutate a source resource's observed document.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Attempt to resolve all slots of a PendingTemplate.
 * Returns the reconstructed string if all slots resolve, undefined otherwise.
 */
function resolvePendingTemplate(
  template: PendingTemplate,
  resourceById: ReadonlyMap<string, import('../core/resource.js').Resource>,
): string | undefined {
  const values: string[] = [];
  for (const slot of template.slots) {
    const sourceResource = resourceById.get(slot.source.id);
    if (!sourceResource) return undefined;
    const observed = getObservedDocument(sourceResource);
    const resolved = getNestedValue(observed, slot.path);
    if (resolved === undefined || resolved === null) return undefined;
    values.push(String(resolved));
  }
  let result = template.parts[0]!;
  for (let i = 0; i < values.length; i++) {
    result += values[i] + template.parts[i + 1]!;
  }
  return result;
}
