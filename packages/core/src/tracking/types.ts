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

// ─── PendingMerge ────────────────────────────────────────────────────────────

/**
 * A marker for a cross-resource reference that has had local child fields
 * written into it — i.e. "clone the source's value, then override these keys."
 *
 * Produced when a deep write targets a child of a node that currently holds a
 * {@link Pending} (or {@link PendingTemplate}) reference, e.g.
 *
 * ```ts
 * A.spec.foo = B.spec.foo;   // A.spec.foo holds a Pending → B's spec.foo
 * A.spec.foo.bar = 'baz';    // becomes a PendingMerge: base = B.spec.foo,
 *                            //   overrides = { bar: 'baz' }
 * ```
 *
 * The object-vs-primitive decision is deferred to the resolve phase:
 * - base resolves to an object → deep-merge `overrides` on top (overrides win).
 * - base resolves to a primitive/array → the resolve phase throws.
 * - base still unobserved → the node stays pending and the resource is blocked.
 */
const PENDING_MERGE_TAG: unique symbol = Symbol.for(
  'xplane.pendingMerge',
) as unknown as typeof PENDING_MERGE_TAG;

export class PendingMerge {
  static readonly TAG = PENDING_MERGE_TAG;
  readonly [PENDING_MERGE_TAG] = true;

  constructor(
    /** The resource that owns the base observed data. */
    readonly source: ResourceRef,
    /** The path within that resource's observed data (dot-separated). */
    readonly path: string,
    /**
     * Local child writes to merge on top of the resolved base. May itself
     * contain nested Pending / PendingTemplate / PendingMerge values.
     */
    readonly overrides: Record<string, unknown>,
  ) {}

  static is(value: unknown): value is PendingMerge {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[PENDING_MERGE_TAG] === true
    );
  }
}
