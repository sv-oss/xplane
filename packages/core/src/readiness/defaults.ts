import type { ReadyCheck } from './types.js';

/**
 * Checks if the resource has a `Ready` condition with status `True`.
 */
export function conditionReady(observed: Record<string, unknown>): boolean | undefined {
  const status = observed.status as Record<string, unknown> | undefined;
  const conditions = status?.conditions as Array<Record<string, unknown>> | undefined;
  if (!conditions || !Array.isArray(conditions)) return undefined;

  const ready = conditions.find((c) => c.type === 'Ready');
  if (!ready) return undefined;

  return ready.status === 'True';
}

/**
 * Checks if the resource has `status.ready === true`.
 */
export function statusReady(observed: Record<string, unknown>): boolean | undefined {
  const status = observed.status as Record<string, unknown> | undefined;
  if (status === undefined) return undefined;
  if (!('ready' in status)) return undefined;

  return status.ready === true;
}

/**
 * Fallback: resource exists in observed state → ready.
 * Always returns `true` (only called when observed is defined).
 */
export function exists(_observed: Record<string, unknown>): boolean {
  return true;
}

/**
 * Built-in default readiness checks, appended at low priority.
 */
export const DEFAULT_CHECKS: ReadyCheck[] = [
  { fn: conditionReady, priority: 100, name: 'conditionReady' },
  { fn: statusReady, priority: 200, name: 'statusReady' },
  { fn: exists, priority: 1000, name: 'exists' },
];
