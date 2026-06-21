import {
  getDesiredDocument,
  getExternalRef,
  getObservedDocument,
  getResourceRef,
  isExternal,
} from '../core/resource.js';
import { Pending } from '../tracking/index.js';

import type { DiagnosticReport, PipelineState } from './types.js';

/**
 * DIAGNOSE phase: produce structured diagnostics for blocked resources.
 *
 * For each resource classified as 'blocked':
 * - Find all Pending markers in the desired document
 * - Report what they're waiting on (source resource + path)
 *
 * For circular dependencies (detected in sequence phase):
 * - Produce a 'cycle' diagnostic with the full cycle path
 */
export function diagnose(state: PipelineState): PipelineState {
  const diagnostics: DiagnosticReport[] = [];

  // Check for cycles from the graph
  const sortResult = state.graph.topologicalSort();
  if (sortResult.order === null && sortResult.cycle) {
    const firstCycleMember = sortResult.cycle[0];
    if (firstCycleMember) {
      diagnostics.push({
        resource: firstCycleMember,
        reason: 'cycle',
        cycle: sortResult.cycle,
      });
    }
  }

  // Report external resources that were required but not found.
  // Skip externals whose lookup name is itself unresolved (still a pending
  // template token, or non-string): the handler never sent a require for
  // them, so they aren't "not found" — they are downstream-blocked, and the
  // root cause (whatever upstream they're waiting on) will be reported on
  // its own.
  for (const resource of state.resources) {
    if (!isExternal(resource)) continue;
    const ref = getExternalRef(resource);
    if (!ref) continue;
    const observed = getObservedDocument(resource);
    if (Object.keys(observed).length > 0) continue; // hydrated, no problem
    if (typeof ref.name !== 'string' || ref.name.startsWith('__pending__')) continue;
    const nsDisplay = ref.namespace ? ` in namespace '${ref.namespace}'` : '';
    diagnostics.push({
      resource: getResourceRef(resource).id,
      reason: 'not-found',
      detail: `External resource ${ref.apiVersion}/${ref.kind} '${ref.name}'${nsDisplay} was required but not found by Crossplane`,
    });
  }

  // For each blocked resource, find pending paths
  const pendingDiagnostics: DiagnosticReport[] = [];
  for (const resource of state.resources) {
    if (isExternal(resource)) continue;

    const ref = getResourceRef(resource);
    const classification = state.classification.get(ref.id);
    if (classification !== 'blocked') continue;

    // Skip if already reported as cycle member
    if (sortResult.order === null && sortResult.cycle?.includes(ref.id)) continue;

    const desired = getDesiredDocument(resource);
    const pendingPaths = findPendingPaths(desired, '');

    if (pendingPaths.length > 0) {
      pendingDiagnostics.push({
        resource: ref.id,
        reason: 'pending',
        pendingPaths,
      });
    }
  }

  // Filter out cascading diagnostics: only keep pending diagnostics that have
  // at least one dependency that is NOT itself blocked or not-found.
  // This surfaces only root causes rather than the full dependency cascade.
  const notFoundIds = new Set(
    diagnostics.filter((d) => d.reason === 'not-found').map((d) => d.resource),
  );
  const blockedIds = new Set(pendingDiagnostics.map((d) => d.resource));

  for (const diag of pendingDiagnostics) {
    const isRootCause = diag.pendingPaths?.some((p) => {
      const dep = p.waitingOn.resource;
      // If waiting on something that isn't blocked or not-found, this IS a root cause
      return !blockedIds.has(dep) && !notFoundIds.has(dep);
    });
    if (isRootCause) {
      diagnostics.push(diag);
    }
  }

  // Emit `dependency` diagnostics for resources blocked by explicit
  // construct-level dependencies (node.addDependency). Only surface those
  // whose waiting targets are not themselves blocked/not-found — same root-
  // cause filtering as for pending diagnostics.
  if (state.dependencyBlocks) {
    for (const [resourceId, waitingOn] of state.dependencyBlocks) {
      // Skip if already covered by a cycle/not-found/pending diagnostic.
      if (diagnostics.some((d) => d.resource === resourceId)) continue;
      const rootCauses = waitingOn.filter(
        (id) => !blockedIds.has(id) && !notFoundIds.has(id) && !state.dependencyBlocks?.has(id),
      );
      if (rootCauses.length === 0) continue;
      diagnostics.push({
        resource: resourceId,
        reason: 'dependency',
        waitingOn: rootCauses,
      });
    }
  }

  return { ...state, diagnostics };
}

/**
 * Recursively find all Pending markers in a document and report their source.
 */
function findPendingPaths(
  obj: unknown,
  basePath: string,
): Array<{ path: string; waitingOn: { resource: string; path: string } }> {
  const results: Array<{ path: string; waitingOn: { resource: string; path: string } }> = [];

  if (obj === null || obj === undefined) return results;
  if (Pending.is(obj)) {
    results.push({
      path: basePath,
      waitingOn: { resource: obj.source.id, path: obj.path },
    });
    return results;
  }
  if (typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const childPath = basePath ? `${basePath}[${i}]` : `[${i}]`;
      results.push(...findPendingPaths(obj[i], childPath));
    }
    return results;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const childPath = basePath ? `${basePath}.${key}` : key;
    results.push(...findPendingPaths(value, childPath));
  }
  return results;
}
