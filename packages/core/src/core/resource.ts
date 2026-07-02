import { Construct } from 'constructs';

import type { ReadyCheck, ReadyCheckFn } from '../readiness/index.js';
import {
  createPrimitiveReadProxy,
  createReadProxy,
  createWriteProxy,
  type DependencyGraph,
  type EdgeCollector,
  getReadProxyMeta,
  isReadProxy,
  Pending,
  type ResourceRef,
} from '../tracking/index.js';
import { processStringValue } from '../tracking/token-registry.js';
import { compositionStorage } from './context.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape for a Kubernetes resource — only apiVersion + kind required. */
export interface KubernetesResource {
  apiVersion: string;
  kind: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Props passed to the Resource constructor — becomes the desired document. */
export interface ResourceProps {
  apiVersion: string;
  kind: string;
  [key: string]: unknown;
}

/** Framework configuration accessible via `resource.resource`. */
export interface ResourceConfig<TObserved = Record<string, unknown>> {
  autoReady: boolean;
  addReadyCheck(fn: (observed: TObserved) => boolean | undefined, priority?: number): void;
}

/** Internal metadata stored per Resource (not exposed on the proxy). */
interface ResourceInternals {
  /** Unique reference for the dependency graph. */
  ref: ResourceRef;
  /** The desired document (what the user wrote). */
  desired: Record<string, unknown>;
  /** The observed document (populated by the hydrate phase). */
  observed: Record<string, unknown>;
  /** Whether this is an external (existing) resource. */
  external: boolean;
  /** For external resources: the lookup key. */
  externalRef?: ExternalResourceRef;
  /** Framework config. */
  config: ResourceConfig;
  /** Custom readiness checks registered by the composition author. */
  readyChecks: ReadyCheck[];
  /** The dependency graph. */
  graph: DependencyGraph;
  /** The edge collector. */
  collector: EdgeCollector;
}

export interface ExternalResourceRef {
  apiVersion: string;
  kind: string;
  name: unknown;
  namespace?: string;
  refKey: string;
}

// ─── WeakMap stores for internal data ─────────────────────────────────────────

const internals = new WeakMap<Resource, ResourceInternals>();

// ─── Resource class ───────────────────────────────────────────────────────────

/**
 * A Kubernetes resource within a Composition.
 *
 * The Resource instance acts as a "desired-first, fallback-to-observed" proxy:
 * - Reading a path that exists in the desired document returns the desired value.
 * - Reading a path that does NOT exist in desired falls through to a tracked
 *   ReadProxy over observed state (creates dependency edges).
 * - Writing always goes to the desired document.
 *
 * The only reserved properties are `node` (from Construct) and `resource`
 * (framework config namespace).
 */
export class Resource extends Construct {
  readonly resource: ResourceConfig;
  declare metadata: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };

  constructor(scope: Construct, id: string, props: ResourceProps) {
    super(scope, id);

    const graph = scope.node.tryGetContext('xplane:graph') as DependencyGraph;
    const collector = scope.node.tryGetContext('xplane:collector') as EdgeCollector;

    if (!graph || !collector) {
      throw new Error('Resource must be created within a Composition tree.');
    }

    const ref: ResourceRef = { id: this.node.path };
    graph.addResource(ref);

    const readyChecks: ReadyCheck[] = [];
    const config: ResourceConfig = {
      autoReady: true,
      addReadyCheck(fn: ReadyCheckFn, priority = 50) {
        readyChecks.push({ fn, priority });
      },
    };
    this.resource = config;

    // Process props — deep scan for ReadProxy values in the desired doc
    const desired = processDesiredProps(props, ref, collector);

    const internal: ResourceInternals = {
      ref,
      desired,
      observed: {},
      external: false,
      config,
      readyChecks,
      graph,
      collector,
    };
    internals.set(this, internal);

    // Pre-hydrate composed resources from observed data if available — so that
    // proxy reads during sibling construction (e.g. `Secret.fromExistingByName(this, other.status.x)`)
    // return real values instead of pending tokens that bake into construct IDs.
    const ctx = compositionStorage.getStore();
    if (ctx) {
      const observed = ctx.observedComposed.get(this.node.path);
      if (observed) {
        Object.assign(internal.observed, observed);
      }
    }

    // Return a proxy over `this` that implements the desired-first/observed-fallback
    const proxy = createResourceProxy(this, internal);

    // Patch the construct tree so node.children / findAll() yield the proxy
    // instead of the raw instance (which was registered during super()).
    // biome-ignore lint/suspicious/noExplicitAny: accessing private _children is intentional
    (scope.node as any)._children[this.node.id] = proxy;

    // Patch node.host so that node.findAll() (used by .with()) starts from the
    // proxy rather than the raw instance. Without this, applyTo() receives the
    // raw Resource where declared-only fields like `spec` are undefined at runtime.
    // biome-ignore lint/suspicious/noExplicitAny: patching constructs Node internals is intentional
    (this.node as any).host = proxy;

    // biome-ignore lint/correctness/noConstructorReturn: Proxy wrapping is intentional
    return proxy;
  }

  /**
   * Look up an existing cluster resource by name.
   * Returns a Resource that only has observed state (no desired output).
   *
   * The `name` parameter accepts either a plain string or a PrimitiveReadProxy
   * (returned when reading a tracked property like `ns.metadata.labels['x']`).
   * Proxies are coerced to their underlying string via `Symbol.toPrimitive`.
   */
  static fromExistingByName(
    scope: Construct,
    apiVersion: string,
    kind: string,
    name: unknown,
    namespace?: string,
  ): Resource {
    const resolvedName = coerceToString(name);
    const refKey = computeRefKey(apiVersion, kind, resolvedName, namespace);
    const id = `__existing__${refKey.replace(/\//g, '_')}`;

    const instance = new Resource(scope, id, { apiVersion, kind });
    const internal = internals.get(instance)!;
    internal.external = true;
    internal.externalRef = { apiVersion, kind, name: resolvedName ?? name, namespace, refKey };

    // Pre-hydrate from context if observed data is already available (from a prior iteration)
    const ctx = compositionStorage.getStore();
    if (ctx) {
      const observed = ctx.requiredResources.get(refKey);
      if (observed) {
        Object.assign(internal.observed, observed);
      }
    }

    return instance;
  }

  /**
   * Generate a deterministic unique name based on the XR identity and construct path.
   * Useful for resource fields that need unique names (e.g., AWS resource names).
   */
  static uniqueName(
    scope: Construct,
    options: {
      maxLength?: number;
      separator?: string;
      allowedPattern?: RegExp;
      extra?: string;
    } = {},
  ): string {
    const maxLength = options.maxLength ?? 63;
    const separator = options.separator ?? '-';
    const allowedPattern = options.allowedPattern ?? /[^a-zA-Z0-9]/g;
    const escapedSep = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const collapseRe = new RegExp(`${escapedSep}+`, 'g');

    const clean = (s: string) =>
      s
        .replace(/\s+/g, '')
        .replace(allowedPattern, separator)
        .replace(collapseRe, separator)
        .replace(new RegExp(`^${escapedSep}|${escapedSep}$`, 'g'), '');

    const xrMeta = scope.node.tryGetContext('xplane:xr-meta') as
      | { name?: string; namespace?: string }
      | undefined;

    const parts: string[] = [];
    if (xrMeta?.namespace) parts.push(clean(xrMeta.namespace));
    if (xrMeta?.name) parts.push(clean(xrMeta.name));
    for (const s of scope.node.scopes.slice(1)) {
      const c = clean(s.node.id);
      if (c) parts.push(c);
    }
    if (options.extra) {
      const c = clean(options.extra);
      if (c) parts.push(c);
    }

    const full = parts.join(separator);
    const hash = shortHash(full);
    const withHash = `${full}${separator}${hash}`;

    if (withHash.length <= maxLength) return withHash;
    const prefix = full.slice(0, maxLength - hash.length - separator.length);
    return `${prefix}${separator}${hash}`;
  }

  /**
   * Like {@link uniqueName} but produces names compliant with RFC 1123 DNS labels:
   * lowercase alphanumeric characters and hyphens only, starting and ending with
   * an alphanumeric character. Suitable for use as Kubernetes resource names.
   */
  static uniqueNameRfc1123(
    scope: Construct,
    options: {
      maxLength?: number;
      extra?: string;
    } = {},
  ): string {
    const maxLength = options.maxLength ?? 63;

    const clean = (s: string) =>
      s
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    const xrMeta = scope.node.tryGetContext('xplane:xr-meta') as
      | { name?: string; namespace?: string }
      | undefined;

    const parts: string[] = [];
    if (xrMeta?.namespace) parts.push(clean(xrMeta.namespace));
    if (xrMeta?.name) parts.push(clean(xrMeta.name));
    for (const s of scope.node.scopes.slice(1)) {
      const c = clean(s.node.id);
      if (c) parts.push(c);
    }
    if (options.extra) {
      const c = clean(options.extra);
      if (c) parts.push(c);
    }

    const full = parts.join('-');
    const hash = shortHash(full);
    const withHash = `${full}-${hash}`;

    if (withHash.length <= maxLength) return withHash;
    const prefix = full.slice(0, maxLength - hash.length - 1);
    const trimmedPrefix = prefix.replace(/-+$/, '');
    return trimmedPrefix ? `${trimmedPrefix}-${hash}` : hash;
  }
}

// ─── Internal accessors (used by pipeline phases) ─────────────────────────────

export function getResourceInternals(resource: Resource): ResourceInternals {
  const internal = internals.get(resource);
  if (!internal) throw new Error('Resource internals not found');
  return internal;
}

export function getResourceRef(resource: Resource): ResourceRef {
  return getResourceInternals(resource).ref;
}

export function getDesiredDocument(resource: Resource): Record<string, unknown> {
  return getResourceInternals(resource).desired;
}

export function getObservedDocument(resource: Resource): Record<string, unknown> {
  return getResourceInternals(resource).observed;
}

export function hydrateObserved(resource: Resource, data: Record<string, unknown>): void {
  const internal = getResourceInternals(resource);
  Object.assign(internal.observed, data);
}

export function isExternal(resource: Resource): boolean {
  return getResourceInternals(resource).external;
}

export function getExternalRef(resource: Resource): ExternalResourceRef | undefined {
  return getResourceInternals(resource).externalRef;
}

export function getReadyChecks(resource: Resource): ReadyCheck[] {
  return getResourceInternals(resource).readyChecks;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerce a value to a string, handling PrimitiveReadProxy objects that wrap
 * primitive values behind a `Symbol.toPrimitive` method.
 * Returns `undefined` if the value cannot be resolved to a string.
 *
 * Reads via `valueOf` rather than `String()`/`Symbol.toPrimitive`: the latter
 * intentionally returns a registry-backed token on `PrimitiveReadProxy` so
 * template-literal coercion can record dependency edges. For ID/name use
 * sites we need the raw concrete value, otherwise we'd construct lookup
 * keys containing `__pending__tpl_*__` tokens.
 */
function coerceToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  // Only unwrap proxy-like objects (not raw primitives like `42`, which
  // should fall through to the caller's `name` fallback). PrimitiveReadProxy
  // exposes the raw value via `valueOf` — bypassing `Symbol.toPrimitive`,
  // which intentionally returns a registry-backed token under a composition
  // run so template-literal coercion can record dependency edges.
  if (value != null && typeof value === 'object') {
    const v = value as { valueOf?: () => unknown };
    if (typeof v.valueOf === 'function') {
      const raw = v.valueOf();
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    }
  }
  return undefined;
}

export function computeRefKey(
  apiVersion: string,
  kind: string,
  name: string | undefined,
  namespace?: string,
): string {
  const namePart = name ?? '__unresolved__';
  if (namespace) return `${apiVersion}/${kind}/${namespace}/${namePart}`;
  return `${apiVersion}/${kind}/${namePart}`;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Process the desired props — deep-scan for ReadProxy values and replace them
 * with Pending markers (recording edges in the collector).
 */
function processDesiredProps(
  props: ResourceProps,
  owner: ResourceRef,
  collector: EdgeCollector,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    result[key] = processValue(value, owner, key, collector);
  }
  return result;
}

function processValue(
  value: unknown,
  owner: ResourceRef,
  path: string,
  collector: EdgeCollector,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return processStringValue(value, (meta) => {
      collector.add({ from: meta.owner, fromPath: meta.path, to: owner, toPath: path });
    });
  }

  if (typeof value !== 'object') return value;

  if (isReadProxy(value)) {
    const meta = getReadProxyMeta(value)!;
    collector.add({
      from: meta.owner,
      fromPath: meta.path,
      to: owner,
      toPath: path,
    });
    // Try to get concrete value
    const prim = tryExtractPrimitive(value);
    if (prim !== undefined) return prim;
    return new Pending(meta.owner, meta.path);
  }

  if (Array.isArray(value as object)) {
    return (value as unknown[]).map((item, i) =>
      processValue(item, owner, `${path}[${i}]`, collector),
    );
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = processValue(val, owner, `${path}.${key}`, collector);
  }
  return result;
}

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
 * Creates the "desired-first, fallback-to-observed" proxy around a Resource.
 */
function createResourceProxy(resource: Resource, internal: ResourceInternals): Resource {
  const { ref, desired, collector } = internal;

  const proxy = new Proxy(resource, {
    get(target, prop, receiver) {
      // Framework reserved properties
      if (prop === 'node') return Reflect.get(target, prop, receiver);
      if (prop === 'resource') return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);

      // Prototype methods and inherited Construct methods (e.g. .with(), .toString())
      if (prop === 'constructor') return Reflect.get(target, prop, receiver);
      const protoValue = Reflect.get(target, prop, receiver);
      if (typeof protoValue === 'function') return protoValue.bind(proxy);

      // Check desired first
      if (prop in desired) {
        const value = desired[String(prop)];
        if (typeof value === 'object' && value !== null && !Pending.is(value)) {
          // Return a WriteProxy so nested writes go to desired
          // Pass observed at the same path for fallback reads
          const observed = internal.observed;
          const observedAtPath =
            String(prop) in observed && typeof observed[String(prop)] === 'object'
              ? (observed[String(prop)] as Record<string, unknown>)
              : {};
          return createWriteProxy(value as object, {
            owner: ref,
            collector,
            basePath: String(prop),
            observed: observedAtPath,
          });
        }
        return value;
      }

      // Fallback to observed via ReadProxy
      const observed = internal.observed;
      if (String(prop) in observed) {
        const value = observed[String(prop)];
        if (typeof value === 'object' && value !== null) {
          return createReadProxy(value as object, ref, String(prop));
        }
        // Primitive observed value — wrap in ReadProxy for tracking
        return createPrimitiveReadProxyFromResource(value, ref, String(prop));
      }

      // Path exists in neither — return a lazy-init proxy that behaves as a
      // ReadProxy for reads but auto-initializes the path in desired on write.
      return createLazyInitProxy(desired, ref, collector, String(prop));
    },

    set(target, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
      if (prop === 'resource') return Reflect.set(target, prop, value);

      // All writes go to desired, processing ReadProxy values
      const path = String(prop);
      desired[path] = processValue(value, ref, path, collector);
      return true;
    },

    has(target, prop) {
      if (typeof prop === 'symbol') return Reflect.has(target, prop);
      if (prop === 'node' || prop === 'resource') return true;
      return prop in desired || prop in internal.observed;
    },
  }) as Resource;

  // Store internal mapping for the proxy too, so internals.get(proxy) works
  internals.set(proxy, internal);
  return proxy;
}

/**
 * Wrap a primitive observed value so it carries ReadProxy metadata
 * for dependency tracking when assigned elsewhere.
 */
function createPrimitiveReadProxyFromResource(
  value: unknown,
  owner: ResourceRef,
  path: string,
): unknown {
  if (value === null || value === undefined) return value;
  return createPrimitiveReadProxy(value as string | number | boolean, owner, path);
}

/**
 * Creates a proxy for a path that exists in neither desired nor observed.
 * - Reading nested properties returns ReadProxy leaves (for dependency tracking).
 * - Writing a nested property auto-initializes the path in desired and stores the value.
 */
function createLazyInitProxy(
  desired: Record<string, unknown>,
  owner: ResourceRef,
  collector: EdgeCollector,
  basePath: string,
): object {
  const readProxy = createReadProxy({} as object, owner, basePath);

  return new Proxy(readProxy as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      // Delegate reads to the ReadProxy (for tracking)
      return Reflect.get(target, prop, receiver);
    },

    set(_target, prop, value) {
      if (typeof prop === 'symbol') return false;
      // Auto-initialize the parent object in desired
      let container = desired[basePath] as Record<string, unknown> | undefined;
      if (!container || typeof container !== 'object') {
        container = {};
        desired[basePath] = container;
      }
      container[String(prop)] = processValue(
        value,
        owner,
        `${basePath}.${String(prop)}`,
        collector,
      );
      return true;
    },
  });
}
