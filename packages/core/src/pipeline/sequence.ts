import { getDesiredDocument, getResourceRef, isExternal } from '../core/resource.js';
import { Pending, PendingTemplate } from '../tracking/index.js';

import type { PipelineState, ResourceClassification } from './types.js';

/**
 * SEQUENCE phase: topological sort and classification.
 *
 * - Runs topological sort on the dependency graph.
 * - Classifies each resource as 'emit', 'blocked', or 'external'.
 * - A resource is 'blocked' if it still has Pending markers in its desired document.
 * - External resources are classified as 'external' (never emitted).
 * - Circular dependencies are detected via the graph's topological sort.
 */
export function sequence(state: PipelineState): PipelineState {
  const classification = new Map<string, ResourceClassification>();

  // Run topological sort for cycle detection
  const sortResult = state.graph.topologicalSort();

  // Classify each resource
  for (const resource of state.resources) {
    const ref = getResourceRef(resource);

    if (isExternal(resource)) {
      classification.set(ref.id, 'external');
      continue;
    }

    // Check if this resource has any remaining Pending markers
    const desired = getDesiredDocument(resource);
    const hasPending = containsPending(desired);

    if (hasPending) {
      classification.set(ref.id, 'blocked');
    } else {
      classification.set(ref.id, 'emit');
    }
  }

  // If there's a cycle, mark all cycle members as blocked
  if (sortResult.order === null && sortResult.cycle) {
    for (const id of sortResult.cycle) {
      if (classification.get(id) !== 'external') {
        classification.set(id, 'blocked');
      }
    }
  }

  return { ...state, classification };
}

/**
 * Recursively check if an object contains any Pending markers.
 */
function containsPending(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (Pending.is(obj)) return true;
  if (PendingTemplate.is(obj)) return true;
  if (typeof obj !== 'object') return false;

  if (Array.isArray(obj)) {
    return obj.some(containsPending);
  }

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (containsPending(value)) return true;
  }
  return false;
}
