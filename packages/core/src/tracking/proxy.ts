import {
  type DependencyEdge,
  IS_TRACKED,
  type ResourceRef,
  TRACKING_META,
  type TrackingMeta,
} from './types.js';

/**
 * Registry that collects dependency edges discovered during proxy access.
 * Shared across all tracked values within a single composition run.
 */
export class DependencyCollector {
  private readonly _edges: DependencyEdge[] = [];

  addEdge(edge: DependencyEdge): void {
    const exists = this._edges.some(
      (e) =>
        e.from.id === edge.from.id &&
        e.fromPath === edge.fromPath &&
        e.to.id === edge.to.id &&
        e.toPath === edge.toPath,
    );
    if (!exists) {
      this._edges.push(edge);
    }
  }

  get edges(): ReadonlyArray<DependencyEdge> {
    return this._edges;
  }

  clear(): void {
    this._edges.length = 0;
  }
}

/** Options for creating a tracked proxy. */
export interface TrackedProxyOptions {
  /** Which resource this value belongs to. */
  owner: ResourceRef;
  /** Dot-path from the resource root (e.g. "spec.forProvider.region"). */
  path: string;
  /** Whether this originates from observed state. */
  observed: boolean;
  /** Shared collector for discovered dependencies. */
  collector: DependencyCollector;
}

/**
 * Returns true if `value` is a tracked proxy created by `createTrackedProxy`.
 */
export function isTracked(value: unknown): value is object & { [TRACKING_META]: TrackingMeta } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[IS_TRACKED] === true
  );
}

/**
 * Retrieves the tracking metadata from a tracked proxy.
 * Returns undefined if the value is not tracked.
 */
export function getTrackingMeta(value: unknown): TrackingMeta | undefined {
  if (isTracked(value)) {
    return (value as Record<symbol, TrackingMeta>)[TRACKING_META];
  }
  return undefined;
}

/**
 * Creates a proxy around `target` that:
 * 1. Returns nested proxies for property access (building up dot-paths).
 * 2. On set: if the assigned value is itself a tracked proxy from a *different*
 *    resource, records a DependencyEdge in the collector.
 * 3. Stores concrete values normally so the underlying object is populated.
 *
 * For "observed" proxies, property reads on missing keys return a nested
 * tracked proxy (representing an "unknown" value) rather than undefined.
 * This lets `vpc.status.atProvider.vpcId` work even before the VPC exists.
 */
export function createTrackedProxy<T extends object>(target: T, opts: TrackedProxyOptions): T {
  const meta: TrackingMeta = {
    owner: opts.owner,
    path: opts.path,
    observed: opts.observed,
  };

  return new Proxy(target, {
    get(obj, prop, receiver) {
      // Metadata access — non-enumerable
      if (prop === TRACKING_META) return meta;
      if (prop === IS_TRACKED) return true;

      // When an observed placeholder proxy is used in string/number context
      // (e.g. template literals), throw a clear error instead of "[object Object]"
      if (prop === Symbol.toPrimitive) {
        if (opts.observed && Object.keys(obj).length === 0) {
          return () => {
            throw new Error(
              `Cannot coerce XR path '${opts.path}' to a primitive — the field does not exist in the composite resource`,
            );
          };
        }
        return Reflect.get(obj, prop, receiver);
      }

      // Allow standard iteration / serialization protocols
      if (typeof prop === 'symbol') {
        return Reflect.get(obj, prop, receiver);
      }

      // Standard object methods
      if (prop === 'toJSON') {
        return () => obj;
      }

      const existing = Reflect.get(obj, prop, receiver);

      // If the value is already a tracked proxy, return as-is
      if (isTracked(existing)) {
        return existing;
      }

      // If it's a plain object or array, wrap it in a tracked proxy
      if (typeof existing === 'object' && existing !== null) {
        const wrapped = createTrackedProxy(existing as object, {
          owner: opts.owner,
          path: opts.path ? `${opts.path}.${prop}` : String(prop),
          observed: opts.observed,
          collector: opts.collector,
        });
        // Cache the wrapped version
        Reflect.set(obj, prop, wrapped);
        return wrapped;
      }

      // Primitive that exists — return it
      if (existing !== undefined || prop in obj) {
        return existing;
      }

      // For observed proxies, missing keys return a nested proxy
      // representing an "unknown" future value
      if (opts.observed) {
        const placeholder: Record<string, unknown> = {};
        const wrapped = createTrackedProxy(placeholder, {
          owner: opts.owner,
          path: opts.path ? `${opts.path}.${prop}` : String(prop),
          observed: true,
          collector: opts.collector,
        });
        // Do NOT cache on observed — it's a virtual path
        return wrapped;
      }

      // For desired proxies, auto-create nested objects so that
      // chained assignments like `spec.forProvider.vpcId = ...` work
      const autoCreated: Record<string, unknown> = {};
      const wrapped = createTrackedProxy(autoCreated, {
        owner: opts.owner,
        path: opts.path ? `${opts.path}.${prop}` : String(prop),
        observed: false,
        collector: opts.collector,
      });
      Reflect.set(obj, prop, wrapped);
      return wrapped;
    },

    set(obj, prop, value) {
      if (typeof prop === 'symbol') {
        return Reflect.set(obj, prop, value);
      }

      const targetPath = opts.path ? `${opts.path}.${prop}` : String(prop);

      // If the value being assigned is a tracked proxy from another resource,
      // record a dependency edge
      if (isTracked(value)) {
        const sourceMeta = getTrackingMeta(value);

        // XR values (owner "__xr__") are always fully available at
        // construction time — resolve them immediately without creating
        // dependency edges or UNRESOLVED sentinels.
        if (sourceMeta && sourceMeta.owner.id === '__xr__') {
          const concrete = resolveTrackedValue(value);
          // If the XR path doesn't exist, store undefined (not UNRESOLVED)
          return Reflect.set(obj, prop, concrete === UNRESOLVED ? undefined : concrete);
        }

        if (sourceMeta && sourceMeta.owner.id !== opts.owner.id) {
          opts.collector.addEdge({
            from: sourceMeta.owner,
            fromPath: sourceMeta.path,
            to: opts.owner,
            toPath: targetPath,
          });
        }

        // Resolve the concrete value if available, otherwise store a
        // sentinel so serialization knows it's unresolved
        const concrete = resolveTrackedValue(value);
        return Reflect.set(obj, prop, concrete);
      }

      // Plain value — just set it
      if (typeof value === 'object' && value !== null && !isTracked(value)) {
        const wrapped = createTrackedProxy(value as object, {
          owner: opts.owner,
          path: targetPath,
          observed: opts.observed,
          collector: opts.collector,
        });
        return Reflect.set(obj, prop, wrapped);
      }

      return Reflect.set(obj, prop, value);
    },

    ownKeys(obj) {
      return Reflect.ownKeys(obj).filter((k) => typeof k === 'string');
    },

    getOwnPropertyDescriptor(obj, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(obj, prop);
      if (desc) return { ...desc, configurable: true, enumerable: true };
      // For observed proxies, pretend properties exist so spread/destructuring works
      if (opts.observed && typeof prop === 'string') {
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      }
      return undefined;
    },

    has(obj, prop) {
      if (prop === IS_TRACKED || prop === TRACKING_META) return true;
      return Reflect.has(obj, prop);
    },
  });
}

/**
 * Sentinel value used when a tracked reference cannot be resolved yet
 * (the source resource hasn't been observed).
 */
export const UNRESOLVED = Symbol.for('xplane.unresolved');

/**
 * Attempts to extract a concrete (non-proxy) value from a tracked value.
 * Returns UNRESOLVED if the tracked value points to an empty observed path.
 */
function resolveTrackedValue(tracked: unknown): unknown {
  if (!isTracked(tracked)) return tracked;

  // If the underlying object has no own string keys and is observed,
  // it's an unresolved placeholder
  const obj = unwrapProxy(tracked);
  const keys = Object.keys(obj as object);
  const meta = getTrackingMeta(tracked);

  if (keys.length === 0 && meta?.observed) {
    return UNRESOLVED;
  }

  // If it's a primitive wrapper (shouldn't happen often), return the object
  return obj;
}

/**
 * Strips the proxy layer and returns the raw underlying object.
 */
function unwrapProxy(tracked: object): object {
  // Proxies delegate to the target — we can get at raw data via JSON round-trip
  // But that's expensive. Instead, we use ownKeys + get to rebuild.
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(tracked)) {
    result[key] = (tracked as Record<string, unknown>)[key];
  }
  return result;
}
