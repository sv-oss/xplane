import { getOrCreateToken } from './token-registry.js';
import type { ReadProxyMeta, ResourceRef } from './types.js';

/**
 * WeakMap storing metadata for ReadProxy instances.
 * This avoids polluting proxy objects with symbols.
 */
const proxyMeta = new WeakMap<object, ReadProxyMeta>();

/** Sentinel symbol to identify ReadProxy instances. */
const READ_PROXY_TAG = Symbol.for('xplane.readProxy');

/**
 * Check if a value is a ReadProxy.
 */
export function isReadProxy(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[READ_PROXY_TAG] === true
  );
}

/**
 * Get the metadata for a ReadProxy value.
 */
export function getReadProxyMeta(value: unknown): ReadProxyMeta | undefined {
  if (!isReadProxy(value)) return undefined;
  return proxyMeta.get(value as object);
}

/**
 * Creates a ReadProxy that wraps observed data.
 *
 * - Property access navigates into the data, building up the path.
 * - Missing paths return `undefined` (no placeholder proxies).
 * - The proxy carries owner + path metadata so that when it's assigned
 *   to a WriteProxy, the dependency edge can be recorded.
 */
export function createReadProxy<T extends object>(
  target: T,
  owner: ResourceRef,
  basePath: string,
): T {
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      // Identity checks
      if (prop === READ_PROXY_TAG) return true;
      if (typeof prop === 'symbol') return Reflect.get(obj, prop, receiver);
      if (prop === 'toJSON') return () => obj;

      const childPath = basePath ? `${basePath}.${String(prop)}` : String(prop);
      const value = Reflect.get(obj, prop, receiver);

      if (value === undefined || value === null) {
        // Return a "leaf" proxy with undefined target — carries metadata
        // for dependency edge creation but resolves to undefined
        return createLeafReadProxy(owner, childPath);
      }

      if (typeof value === 'object') {
        // Wrap nested objects so path accumulates
        return createReadProxy(value as object, owner, childPath);
      }

      // Primitive — wrap in a tagged object so it can carry metadata
      // when assigned to a WriteProxy
      return createPrimitiveReadProxy(value as string | number | boolean, owner, childPath);
    },

    has(obj, prop) {
      if (prop === READ_PROXY_TAG) return true;
      return Reflect.has(obj, prop);
    },
  });

  proxyMeta.set(proxy, { owner, path: basePath });
  return proxy as T;
}

/**
 * A "leaf" ReadProxy for paths that don't exist in observed data yet.
 * Carries metadata for edge creation. Resolves to `undefined` when
 * coerced to a primitive.
 */
function createLeafReadProxy(owner: ResourceRef, path: string): object {
  const target = Object.create(null) as Record<string | symbol, unknown>;
  const getToken = () => getOrCreateToken(owner, path) ?? `__pending__${owner.id}__${path}`;
  const proxy = new Proxy(target, {
    get(_obj, prop) {
      if (prop === READ_PROXY_TAG) return true;
      if (prop === Symbol.toPrimitive) return () => getToken();
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'toJSON') return () => undefined;
      if (prop === 'toString') return () => getToken();
      if (prop === 'valueOf') return () => proxy;
      // Nested access on a leaf — still a leaf with extended path
      return createLeafReadProxy(owner, `${path}.${String(prop)}`);
    },
    has(_obj, prop) {
      if (prop === READ_PROXY_TAG) return true;
      return false;
    },
  });
  proxyMeta.set(proxy, { owner, path });
  return proxy;
}

/**
 * Wraps a concrete primitive value so it carries ReadProxy metadata.
 * This allows the WriteProxy to detect it during assignment and
 * record the dependency edge, while the value itself resolves correctly.
 */
export function createPrimitiveReadProxy(
  value: string | number | boolean,
  owner: ResourceRef,
  path: string,
): object {
  const target = Object.create(null) as Record<string | symbol, unknown>;
  const proxy = new Proxy(target, {
    get(_obj, prop) {
      if (prop === READ_PROXY_TAG) return true;
      if (prop === Symbol.toPrimitive) return () => value;
      if (prop === 'valueOf') return () => value;
      if (prop === 'toString') return () => String(value);
      if (prop === 'toJSON') return () => value;
      if (typeof prop === 'symbol') return undefined;
      // Navigating into a primitive — leaf
      return createLeafReadProxy(owner, `${path}.${String(prop)}`);
    },
    has(_obj, prop) {
      if (prop === READ_PROXY_TAG) return true;
      return false;
    },
  });
  proxyMeta.set(proxy, { owner, path });
  return proxy;
}
