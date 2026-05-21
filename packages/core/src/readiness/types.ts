/**
 * A readiness check function that evaluates whether a resource is ready
 * based on its observed state.
 *
 * @returns `true` if ready, `false` if not ready, `undefined` if unable to determine
 */
export type ReadyCheckFn = (observed: Record<string, unknown>) => boolean | undefined;

/**
 * A readiness check with an associated priority.
 * Lower priority numbers are evaluated first.
 * Checks at the same priority level are AND-ed together.
 */
export interface ReadyCheck {
  fn: ReadyCheckFn;
  priority: number;
  name?: string;
}
