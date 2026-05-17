import type { KubernetesResource } from '../core/resource.js';

/** Condition from a Kubernetes resource's status.conditions array. */
interface StatusCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/**
 * Determines if a Crossplane managed resource is ready based on its
 * observed status conditions.
 *
 * - If the resource has a `Ready: True` condition → ready.
 * - If the resource has a `Ready: False` condition → not ready.
 * - If the resource exists but has no `Ready` condition at all (e.g. Namespace,
 *   ProviderConfig) → considered ready (the resource exists and is functional).
 * - If not yet observed → not ready.
 */
export function isResourceReady(observed: KubernetesResource | undefined): boolean {
  if (!observed) return false;

  const conditions = observed.status?.conditions as StatusCondition[] | undefined;

  // No conditions at all — resource exists, treat as ready
  if (!Array.isArray(conditions) || conditions.length === 0) return true;

  const readyCondition = conditions.find((c) => c.type === 'Ready');

  // No Ready condition but other conditions exist — treat as ready
  if (!readyCondition) return true;

  return readyCondition.status === 'True';
}

/**
 * Gets the Ready condition from a resource, if present.
 */
export function getReadyCondition(
  observed: KubernetesResource | undefined,
): StatusCondition | undefined {
  if (!observed?.status) return undefined;

  const conditions = observed.status.conditions as StatusCondition[] | undefined;
  if (!Array.isArray(conditions)) return undefined;

  return conditions.find((c) => c.type === 'Ready');
}
