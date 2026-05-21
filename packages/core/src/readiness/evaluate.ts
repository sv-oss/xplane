import { getLogger } from '../logging/index.js';

import type { ReadyCheck } from './types.js';

/**
 * Evaluate readiness for a resource by running checks grouped by priority.
 *
 * - If `observed` is undefined, the resource doesn't exist yet → not ready.
 * - Checks are grouped by priority (ascending). Within a group, all checks
 *   are AND-ed: if any returns `false`, the resource is not ready. If at least
 *   one returns `true` and none return `false`, the resource is ready.
 *   If all return `undefined`, cascade to the next priority group.
 * - Final fallback (no group had a definitive answer): not ready.
 */
export function evaluateReadiness(
  checks: ReadyCheck[],
  observed: Record<string, unknown> | undefined,
): boolean {
  const log = getLogger();

  if (!observed) {
    log.debug('readiness: resource not observed, not ready');
    return false;
  }

  // Group checks by priority
  const groups = new Map<number, ReadyCheck[]>();
  for (const check of checks) {
    const group = groups.get(check.priority);
    if (group) {
      group.push(check);
    } else {
      groups.set(check.priority, [check]);
    }
  }

  // Process groups in ascending priority order
  const priorities = [...groups.keys()].sort((a, b) => a - b);

  for (const priority of priorities) {
    const group = groups.get(priority)!;
    let hasTrue = false;
    let hasFalse = false;
    const results: Array<{ name: string; result: boolean | undefined }> = [];

    for (const check of group) {
      const result = check.fn(observed);
      results.push({ name: check.name ?? 'anonymous', result });

      if (result === false) {
        hasFalse = true;
        break; // Short-circuit: one false in the group → not ready
      }
      if (result === true) {
        hasTrue = true;
      }
    }

    log.debug('readiness: evaluated group', { priority, results });

    if (hasFalse) {
      log.debug('readiness: group returned false, not ready', { priority });
      return false;
    }
    if (hasTrue) {
      log.debug('readiness: group returned true, ready', { priority });
      return true;
    }
    // All undefined → cascade to next group
  }

  log.debug('readiness: no group had definitive answer, not ready');
  return false;
}
