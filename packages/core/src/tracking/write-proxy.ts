import {
  createPrimitiveReadProxy,
  createReadProxy,
  getReadProxyMeta,
  isReadProxy,
} from './read-proxy.js';
import { processStringValue } from './token-registry.js';
import { type DependencyEdge, Pending, type ResourceRef } from './types.js';

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
  const { owner, collector, basePath = '', observed } = opts;

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(obj, prop, receiver);
      if (prop === 'toJSON') return () => obj;

      const value = Reflect.get(obj, prop, receiver);

      // If the value is a nested object (not a Pending), wrap it recursively
      if (typeof value === 'object' && value !== null && !Pending.is(value)) {
        const childPath = basePath ? `${basePath}.${String(prop)}` : String(prop);
        const childObserved =
          observed && String(prop) in observed && typeof observed[String(prop)] === 'object'
            ? (observed[String(prop)] as Record<string, unknown>)
            : undefined;
        return createWriteProxy(value as object, {
          owner,
          collector,
          basePath: childPath,
          observed: childObserved,
        });
      }

      // If value is undefined and observed has data at this path, fall through to ReadProxy
      if (value === undefined && observed && String(prop) in observed) {
        const childPath = basePath ? `${basePath}.${String(prop)}` : String(prop);
        const obsValue = observed[String(prop)];
        if (typeof obsValue === 'object' && obsValue !== null) {
          return createReadProxy(obsValue as object, owner, childPath);
        }
        if (obsValue !== undefined && obsValue !== null) {
          return createPrimitiveReadProxy(obsValue as string | number | boolean, owner, childPath);
        }
      }

      // If value is undefined and observed doesn't have it either, return a leaf ReadProxy
      // so that cross-resource references create proper dependency edges and Pending markers
      if (value === undefined && observed !== undefined) {
        const childPath = basePath ? `${basePath}.${String(prop)}` : String(prop);
        return createReadProxy(Object.create(null) as object, owner, childPath);
      }

      return value;
    },

    set(obj, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(obj, prop, value);

      const targetPath = basePath ? `${basePath}.${String(prop)}` : String(prop);

      // Check if the value being assigned is a ReadProxy
      if (isReadProxy(value)) {
        const meta = getReadProxyMeta(value);
        if (meta && meta.owner.id !== owner.id) {
          // Record dependency edge
          collector.add({
            from: meta.owner,
            fromPath: meta.path,
            to: owner,
            toPath: targetPath,
          });

          // Try to extract a concrete value via Symbol.toPrimitive
          const primitive = tryExtractPrimitive(value);
          if (primitive !== undefined) {
            // The value is already concrete (primitive from observed data)
            return Reflect.set(obj, prop, primitive);
          }

          // Not concrete — store a Pending marker
          return Reflect.set(obj, prop, new Pending(meta.owner, meta.path));
        }

        // Self-reference or XR — try to extract value
        const primitive = tryExtractPrimitive(value);
        if (primitive !== undefined) {
          return Reflect.set(obj, prop, primitive);
        }

        // XR leaf with no value — store Pending
        if (meta) {
          collector.add({
            from: meta.owner,
            fromPath: meta.path,
            to: owner,
            toPath: targetPath,
          });
          return Reflect.set(obj, prop, new Pending(meta.owner, meta.path));
        }
      }

      // String with pending template tokens
      if (typeof value === 'string') {
        const processed = processStringValue(value, (meta) => {
          collector.add({ from: meta.owner, fromPath: meta.path, to: owner, toPath: targetPath });
        });
        return Reflect.set(obj, prop, processed);
      }

      // Plain object — deep-process to catch nested ReadProxy values
      if (typeof value === 'object' && value !== null && !Pending.is(value)) {
        const processed = deepProcessValue(value, owner, targetPath, collector);
        return Reflect.set(obj, prop, processed);
      }

      return Reflect.set(obj, prop, value);
    },

    deleteProperty(obj, prop) {
      return Reflect.deleteProperty(obj, prop);
    },
  }) as T;
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
