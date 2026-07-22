import {
  createPrimitiveReadProxy,
  createReadProxy,
  getReadProxyMeta,
  isReadProxy,
  tagReadProxy,
} from './read-proxy.js';
import { processStringValue } from './token-registry.js';
import {
  type DependencyEdge,
  Pending,
  PendingMerge,
  PendingTemplate,
  type ResourceRef,
} from './types.js';

/**
 * Thrown when a write is attempted against a read-only resource — i.e. one
 * loaded via `Resource.fromExistingByName`, whose desired document is never
 * emitted. Failing loudly avoids silent no-op writes that never take effect.
 */
export class ReadOnlyResourceError extends Error {
  constructor(owner: ResourceRef, path: string) {
    super(
      `Cannot write '${path}' on resource '${owner.id}': it was loaded via fromExistingByName and is read-only.`,
    );
    this.name = 'ReadOnlyResourceError';
  }
}

/**
 * Collector that accumulates dependency edges discovered during
 * WriteProxy assignments.
 */
export class EdgeCollector {
  private readonly _edges: DependencyEdge[] = [];

  add(edge: DependencyEdge): void {
    // Deduplicate
    const exists = this._edges.some(
      (e) =>
        e.from.id === edge.from.id &&
        e.fromPath === edge.fromPath &&
        e.to.id === edge.to.id &&
        e.toPath === edge.toPath,
    );
    if (!exists) this._edges.push(edge);
  }

  get edges(): ReadonlyArray<DependencyEdge> {
    return this._edges;
  }
}

export interface WriteProxyOptions {
  /** The resource that owns this desired document. */
  owner: ResourceRef;
  /** The collector to record edges into. */
  collector: EdgeCollector;
  /** Base path prefix (e.g., "spec" when wrapping the spec subtree). */
  basePath?: string;
  /** Optional observed state at the same path for fallback reads. */
  observed?: Record<string, unknown>;
  /** When true, any write throws — used for read-only (external) resources. */
  readOnly?: boolean;
}

/**
 * Creates a WriteProxy that wraps a desired document.
 *
 * - Writes store values in the target.
 * - When a ReadProxy value is assigned, it records a dependency edge
 *   and stores a Pending marker if the value is not yet concrete.
 * - Reads return the stored value (desired-first).
 */
export function createWriteProxy<T extends object>(target: T, opts: WriteProxyOptions): T {
  const { owner, collector, basePath = '', observed, readOnly } = opts;

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(obj, prop, receiver);
      if (prop === 'toJSON') return () => obj;

      const value = Reflect.get(obj, prop, receiver);
      const childPath = basePath ? `${basePath}.${String(prop)}` : String(prop);

      // Nested plain object in desired — wrap recursively as a WriteProxy
      if (
        typeof value === 'object' &&
        value !== null &&
        !Pending.is(value) &&
        !PendingMerge.is(value) &&
        !PendingTemplate.is(value)
      ) {
        const childObserved =
          observed && String(prop) in observed && typeof observed[String(prop)] === 'object'
            ? (observed[String(prop)] as Record<string, unknown>)
            : undefined;
        return createWriteProxy(value as object, {
          owner,
          collector,
          basePath: childPath,
          observed: childObserved,
          readOnly,
        });
      }

      // Desired unset, but observed holds a primitive here — return a primitive
      // ReadProxy for read coercion (deep-writing into a primitive is rejected
      // by the lazy-write proxy's materialize step).
      if (value === undefined && observed && String(prop) in observed) {
        const obsValue = observed[String(prop)];
        if (obsValue !== null && typeof obsValue !== 'object') {
          return createPrimitiveReadProxy(obsValue as string | number | boolean, owner, childPath);
        }
      }

      // Desired holds a PendingMerge — reading a specific child yields that
      // override (concrete where set); reading the whole node references THIS
      // resource's field (owner), so a downstream consumer resolves against
      // this resource's observed (merged) value rather than the base source —
      // otherwise the local overrides would be silently dropped.
      if (PendingMerge.is(value)) {
        return createLazyWriteProxy({
          owner,
          collector,
          path: childPath,
          target: createReadProxy(value.overrides, owner, childPath),
          materialize: () => value.overrides,
          readOnly,
        });
      }

      // Desired holds a Pending reference — reading it yields a lazy-write proxy
      // that (a) preserves the reference when assigned elsewhere and (b) converts
      // the node to a PendingMerge if a child is written into it.
      if (Pending.is(value)) {
        return createLazyWriteProxy({
          owner,
          collector,
          path: childPath,
          target: createReadProxy(Object.create(null) as object, value.source, value.path),
          metaOverride: { owner: value.source, path: value.path },
          materialize: () =>
            ensureChildContainer(obj as Record<string, unknown>, String(prop), childPath),
          readOnly,
        });
      }

      // Path unset in desired — return a lazy-write proxy so reads fall through
      // to observed (if any) and nested writes auto-vivify into desired.
      if (value === undefined) {
        const obsChild =
          observed && typeof observed === 'object'
            ? (observed as Record<string, unknown>)[String(prop)]
            : undefined;
        const base =
          obsChild !== null && typeof obsChild === 'object'
            ? (obsChild as object)
            : (Object.create(null) as object);
        return createLazyWriteProxy({
          owner,
          collector,
          path: childPath,
          target: createReadProxy(base, owner, childPath),
          materialize: () =>
            ensureChildContainer(obj as Record<string, unknown>, String(prop), childPath),
          readOnly,
        });
      }

      return value;
    },

    set(obj, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(obj, prop, value);

      const targetPath = basePath ? `${basePath}.${String(prop)}` : String(prop);
      if (readOnly) throw new ReadOnlyResourceError(owner, targetPath);
      return Reflect.set(obj, prop, resolveAssignedValue(value, owner, targetPath, collector));
    },

    deleteProperty(obj, prop) {
      return Reflect.deleteProperty(obj, prop);
    },
  }) as T;
}

// ─── Lazy-write proxy (deep auto-vivification) ────────────────────────────────

/**
 * Options for {@link createLazyWriteProxy}.
 */
export interface LazyWriteProxyOptions {
  /** The resource that owns the desired document being written into. */
  owner: ResourceRef;
  /** Collector for dependency edges discovered while assigning child values. */
  collector: EdgeCollector;
  /** Full dotted path of this node (used for edge tracking + ReadProxy identity). */
  path: string;
  /**
   * The read proxy this node delegates reads/coercion to. Child reads are taken
   * from this target (yielding proper leaf / nested / primitive read proxies),
   * so all coercion and dependency-tracking behavior is preserved.
   */
  target: object;
  /**
   * Overrides the ReadProxy identity metadata surfaced when this proxy is
   * assigned cross-resource. Used when the node stands in for a reference whose
   * true source differs from the owning document (e.g. a stored Pending).
   */
  metaOverride?: { owner: ResourceRef; path: string };
  /**
   * Lazily create (if needed) and return the container object in the desired
   * document that this node's child writes should target. Invoked ONLY when a
   * write actually occurs — reads never call it, so reads never pollute desired.
   */
  materialize: () => Record<string, unknown>;
  /** When true, any write throws — used for read-only (external) resources. */
  readOnly?: boolean;
}

/**
 * Creates a proxy for a desired-document path that is not yet materialized.
 *
 * - Reads delegate to `target` (a read proxy), preserving dependency tracking,
 *   primitive coercion, and leaf-token behavior.
 * - Reading a child returns another lazy-write proxy wrapping the target's child
 *   read proxy, so deep reads and deep writes compose.
 * - Writing a child invokes `materialize()` to create the parent chain in the
 *   desired document (applying the collision policy), then stores the processed
 *   value there.
 */
export function createLazyWriteProxy(opts: LazyWriteProxyOptions): object {
  const { owner, collector, path, target, metaOverride, materialize, readOnly } = opts;

  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      // Delegate ReadProxy identity, coercion, and serialization to the target.
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
      if (prop === 'valueOf' || prop === 'toString' || prop === 'toJSON') {
        return Reflect.get(t, prop);
      }

      const childPath = path ? `${path}.${String(prop)}` : String(prop);
      const childTarget = Reflect.get(t, prop) as object;
      return createLazyWriteProxy({
        owner,
        collector,
        path: childPath,
        target: childTarget,
        materialize: () => ensureChildContainer(materialize(), String(prop), childPath),
        readOnly,
      });
    },

    set(_t, prop, value) {
      if (typeof prop === 'symbol') return false;
      const childPath = path ? `${path}.${String(prop)}` : String(prop);
      if (readOnly) throw new ReadOnlyResourceError(owner, childPath);
      const container = materialize();
      container[String(prop)] = resolveAssignedValue(value, owner, childPath, collector);
      return true;
    },

    has(t, prop) {
      return Reflect.has(t, prop);
    },
  });

  const meta = metaOverride ?? { owner, path };
  tagReadProxy(proxy, meta.owner, meta.path);
  return proxy;
}

/**
 * Ensure `parent[key]` is an object container suitable for nested writes and
 * return it, applying the deep-write collision policy:
 * - unset / null            → create and return a fresh object.
 * - plain object            → return it (merge into existing keys).
 * - {@link Pending}         → convert to a {@link PendingMerge}, return its overrides.
 * - {@link PendingMerge}    → return its existing overrides.
 * - {@link PendingTemplate} → throw (a computed string has no child fields).
 * - primitive / array       → throw (naming the path).
 */
export function ensureChildContainer(
  parent: Record<string, unknown>,
  key: string,
  pathForError: string,
): Record<string, unknown> {
  const current = parent[key];

  if (current === undefined || current === null) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }

  if (Pending.is(current)) {
    const overrides: Record<string, unknown> = {};
    parent[key] = new PendingMerge(current.source, current.path, overrides);
    return overrides;
  }

  if (PendingMerge.is(current)) {
    return current.overrides;
  }

  if (PendingTemplate.is(current)) {
    throw new Error(
      `Cannot deep-write into '${pathForError}': the path holds a computed template string, which has no child fields.`,
    );
  }

  if (typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }

  const kind = Array.isArray(current) ? 'an array' : `a ${typeof current}`;
  throw new Error(
    `Cannot deep-write into '${pathForError}': the path already holds ${kind} value.`,
  );
}

/**
 * Resolve a value being assigned to a desired-document field, recording any
 * dependency edges and converting ReadProxy references into concrete values or
 * {@link Pending} markers. Shared by the WriteProxy set trap, the lazy-write
 * proxy, and `Resource.setDesired`.
 */
export function resolveAssignedValue(
  value: unknown,
  owner: ResourceRef,
  targetPath: string,
  collector: EdgeCollector,
): unknown {
  if (isReadProxy(value)) {
    const meta = getReadProxyMeta(value);
    if (meta && meta.owner.id !== owner.id) {
      collector.add({ from: meta.owner, fromPath: meta.path, to: owner, toPath: targetPath });
      const primitive = tryExtractPrimitive(value);
      if (primitive !== undefined) return primitive;
      return new Pending(meta.owner, meta.path);
    }

    // Self-reference or XR — try to extract a concrete value first.
    const primitive = tryExtractPrimitive(value);
    if (primitive !== undefined) return primitive;

    if (meta) {
      collector.add({ from: meta.owner, fromPath: meta.path, to: owner, toPath: targetPath });
      return new Pending(meta.owner, meta.path);
    }
  }

  if (typeof value === 'string') {
    return processStringValue(value, (meta) => {
      collector.add({ from: meta.owner, fromPath: meta.path, to: owner, toPath: targetPath });
    });
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    !Pending.is(value) &&
    !PendingMerge.is(value) &&
    !PendingTemplate.is(value)
  ) {
    return deepProcessValue(value, owner, targetPath, collector);
  }

  return value;
}

/**
 * Try to extract a primitive value from a ReadProxy.
 *
 * Reads via `valueOf` rather than `Symbol.toPrimitive`: the latter
 * intentionally returns a tracking token on PrimitiveReadProxy so
 * template-literal coercion can record dependency edges. `valueOf`
 * keeps the raw concrete value, which is what direct assignment needs.
 * For leaf proxies (no observed value), `valueOf` returns the proxy
 * itself (an object), so the check below returns `undefined` as expected.
 */
function tryExtractPrimitive(proxy: object): string | number | boolean | undefined {
  const valueOfFn = (proxy as { valueOf?: () => unknown }).valueOf;
  if (typeof valueOfFn === 'function') {
    const result = valueOfFn.call(proxy);
    if (result !== undefined && result !== null && typeof result !== 'object') {
      return result as string | number | boolean;
    }
  }
  return undefined;
}

/**
 * Deep-process a plain object/array being assigned to a WriteProxy.
 * Replaces any nested ReadProxy values with Pending markers or concrete values.
 *
 * Exported so other sinks that accept user-produced data (e.g. XR status
 * writes) can run values through the same string/edge-resolution pipeline
 * used by resource fields.
 */
export function deepProcessValue(
  value: unknown,
  owner: ResourceRef,
  basePath: string,
  collector: EdgeCollector,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return processStringValue(value, (meta) => {
      collector.add({ from: meta.owner, fromPath: meta.path, to: owner, toPath: basePath });
    });
  }

  if (typeof value !== 'object') return value;

  if (isReadProxy(value)) {
    const meta = getReadProxyMeta(value)!;
    collector.add({
      from: meta.owner,
      fromPath: meta.path,
      to: owner,
      toPath: basePath,
    });
    const primitive = tryExtractPrimitive(value as object);
    if (primitive !== undefined) return primitive;
    return new Pending(meta.owner, meta.path);
  }

  if (Array.isArray(value as object)) {
    return (value as unknown[]).map((item, i) =>
      deepProcessValue(item, owner, `${basePath}[${i}]`, collector),
    );
  }

  // Plain object — recurse
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = deepProcessValue(val, owner, `${basePath}.${key}`, collector);
  }
  return result;
}
