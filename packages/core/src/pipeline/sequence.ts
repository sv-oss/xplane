import type { Resource } from '../core/resource.js';
import {
  getDesiredDocument,
  getObservedDocument,
  getReadyChecks,
  getResourceRef,
  isExternal,
} from '../core/resource.js';
import { DEFAULT_CHECKS, evaluateReadiness } from '../readiness/index.js';
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
 * - After the Pending-based pass, an explicit-dependency pass runs to a
 *   fixed point: any resource classified `emit` is downgraded to `blocked`
 *   if a graph dependency target is itself blocked, an unobserved external,
 *   or an `emit` resource whose observed state is not yet Ready
 *   (`evaluateReadiness`).
 */
export function sequence(state: PipelineState): PipelineState {
  const classification = new Map<string, ResourceClassification>();

  // Run topological sort for cycle detection
  const sortResult = state.graph.topologicalSort();

  // Index resources by id for dependency lookup
  const byId = new Map<string, Resource>();
  for (const resource of state.resources) byId.set(getResourceRef(resource).id, resource);

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

  // Fixed-point: propagate explicit-dependency blocks. A resource is blocked
  // if any of its graph dependency targets is not yet satisfied.
  const dependencyBlocks = new Map<string, string[]>();
  const isTargetSatisfied = (depId: string): boolean => {
    const cls = classification.get(depId);
    if (cls === undefined) return true; // unknown dep id → don't gate on it
    if (cls === 'blocked') return false;
    const target = byId.get(depId);
    if (!target) return true;
    if (cls === 'external') {
      // External is satisfied iff Crossplane returned a hydrated observed doc.
      return Object.keys(getObservedDocument(target)).length > 0;
    }
    // cls === 'emit' — require the target to be Ready in observed state.
    const observed = state.observedComposed.get(depId);
    if (!observed) return false;
    const checks = [...getReadyChecks(target), ...DEFAULT_CHECKS];
    return evaluateReadiness(checks, observed);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of state.resources) {
      const ref = getResourceRef(resource);
      if (classification.get(ref.id) !== 'emit') continue;
      const deps = state.graph.getDependencies(ref.id);
      if (deps.size === 0) continue;
      const unsatisfied: string[] = [];
      for (const depId of deps) {
        if (depId === ref.id) continue;
        if (!isTargetSatisfied(depId)) unsatisfied.push(depId);
      }
      if (unsatisfied.length > 0) {
        classification.set(ref.id, 'blocked');
        dependencyBlocks.set(ref.id, unsatisfied);
        changed = true;
      }
    }
  }

  return { ...state, classification, dependencyBlocks };
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
