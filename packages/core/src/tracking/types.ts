/** Identifies a resource in the dependency graph. */
export interface ResourceRef {
  readonly id: string;
}

/** A dependency edge between two resources at specific field paths. */
export interface DependencyEdge {
  /** Resource being read from (observed state). */
  readonly from: ResourceRef;
  /** Path in the source resource's observed data. */
  readonly fromPath: string;
  /** Resource being written to (desired state). */
  readonly to: ResourceRef;
  /** Path in the target resource's desired data. */
  readonly toPath: string;
}

/**
 * A Pending marker stored in a desired document when a ReadProxy value
 * is assigned. Carries full source info so the resolve phase knows
 * where to look for the concrete value.
 */
const PENDING_TAG: unique symbol = Symbol.for('xplane.pending') as unknown as typeof PENDING_TAG;

export class Pending {
  static readonly TAG = PENDING_TAG;
  readonly [PENDING_TAG] = true;

  constructor(
    /** The resource that owns the observed data. */
    readonly source: ResourceRef,
    /** The path within that resource's observed data. */
    readonly path: string,
  ) {}

  static is(value: unknown): value is Pending {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[PENDING_TAG] === true
    );
  }
}

/** Metadata associated with a ReadProxy instance. */
export interface ReadProxyMeta {
  readonly owner: ResourceRef;
  readonly path: string;
}

// ─── PendingTemplate ─────────────────────────────────────────────────────────

/**
 * A Pending-like marker for strings produced by template literals that
 * interpolate one or more unresolved ReadProxy values.
 *
 * Holds the template structure so the resolve phase can reconstruct the
 * final string once all dependency slots are available.
 *
 * Invariant: parts.length === slots.length + 1
 *   result = parts[0] + resolved[0] + parts[1] + … + resolved[n-1] + parts[n]
 */
const PENDING_TEMPLATE_TAG: unique symbol = Symbol.for(
  'xplane.pendingTemplate',
) as unknown as typeof PENDING_TEMPLATE_TAG;

export class PendingTemplate {
  static readonly TAG = PENDING_TEMPLATE_TAG;
  readonly [PENDING_TEMPLATE_TAG] = true;

  constructor(
    /** Literal text segments between (and around) pending slots. */
    readonly parts: readonly string[],
    /** The pending slots — each maps to an entry in a resource's observed state. */
    readonly slots: ReadonlyArray<{ source: ResourceRef; path: string }>,
  ) {}

  static is(value: unknown): value is PendingTemplate {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[PENDING_TEMPLATE_TAG] === true
    );
  }
}
