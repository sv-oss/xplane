import { Construct } from 'constructs';

import type { DependencyGraph, EdgeCollector } from '../tracking/index.js';
import { getCompositionContext } from './context.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Base generics for a Composition.
 * - TSpec: shape of the XR's spec
 * - TStatus: shape of the XR's status (writable)
 * - TContext: shape of the pipeline context map keys→values
 */
export type CompositionProps<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
  TContext extends object = Record<string, unknown>,
> = {
  spec?: TSpec;
  status?: TStatus;
  context?: TContext;
};

/** The shape of the XR proxy exposed via `this.xr`. */
export interface XrProxy<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>> {
  spec: TSpec;
  status: TStatus;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Composition class ────────────────────────────────────────────────────────

/**
 * Base class for user-authored Crossplane compositions.
 *
 * Users extend this class and define resources in the constructor:
 *
 * ```ts
 * class MyComposition extends Composition<MySpec, MyStatus> {
 *   constructor() {
 *     super();
 *     const vpc = new Vpc(this, 'vpc', { spec: { ... } });
 *     this.xr.status.vpcId = vpc.status.atProvider.vpcId;
 *   }
 * }
 * ```
 *
 * `this.xr` is a "desired-first, fallback-to-observed" proxy over the XR.
 * `this.pipelineContext` provides typed read-only access to Crossplane function context.
 */
export class Composition<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
  TContext extends object = Record<string, unknown>,
> extends Construct {
  /**
   * The XR proxy — reads from desired first (status writes), falls through to observed.
   * Writing to `this.xr.status.*` sets the composite status output.
   */
  readonly xr: XrProxy<TSpec, TStatus>;

  /** The dependency graph tracking resource relationships. */
  readonly graph: DependencyGraph;

  /** The edge collector accumulating dependency edges. */
  readonly collector: EdgeCollector;

  constructor() {
    // Use 'Composition' as the root construct ID
    super(undefined as unknown as Construct, 'Composition');

    const ctx = getCompositionContext();

    this.graph = ctx.graph;
    this.collector = ctx.collector;

    // Set context values on the construct tree so Resources can find them
    this.node.setContext('xplane:graph', ctx.graph);
    this.node.setContext('xplane:collector', ctx.collector);

    // Set XR metadata on tree for Resource.uniqueName()
    const xrMeta = ctx.xr.metadata as { name?: string; namespace?: string } | undefined;
    if (xrMeta) {
      this.node.setContext('xplane:xr-meta', xrMeta);
    }

    // Build the XR proxy
    this.xr = createXrProxy<TSpec, TStatus>(ctx);
  }

  /**
   * Read-only accessor for Crossplane function pipeline context.
   * Keys are the context keys set by Crossplane or prior functions in the pipeline.
   */
  get pipelineContext(): PipelineContextAccessor<TContext> {
    const ctx = getCompositionContext();
    return {
      get<K extends keyof TContext>(key: K): TContext[K] | undefined {
        return ctx.pipelineContext.get(key as string) as TContext[K] | undefined;
      },
      has(key: keyof TContext): boolean {
        return ctx.pipelineContext.has(key as string);
      },
      keys(): IterableIterator<keyof TContext> {
        return ctx.pipelineContext.keys() as IterableIterator<keyof TContext>;
      },
    };
  }
}

/** Typed read-only interface for pipeline context. */
export interface PipelineContextAccessor<TContext extends object = Record<string, unknown>> {
  get<K extends keyof TContext>(key: K): TContext[K] | undefined;
  has(key: keyof TContext): boolean;
  keys(): IterableIterator<keyof TContext>;
}

// ─── XR Proxy ─────────────────────────────────────────────────────────────────

/**
 * Creates the "desired-first, fallback-to-observed" proxy for the XR.
 *
 * - Reading `xr.spec.*` reads from observed XR spec (creates ReadProxy for tracking)
 * - Writing `xr.status.*` writes to a desired-status store (emitted as composite status)
 * - Other reads fall through to observed
 */
function createXrProxy<TSpec, TStatus>(ctx: {
  xr: Record<string, unknown>;
  graph: DependencyGraph;
  collector: EdgeCollector;
}): XrProxy<TSpec, TStatus> {
  const xrObserved = ctx.xr;
  const xrDesiredStatus: Record<string, unknown> = {};

  // The XR ref for dependency tracking
  const xrRef = { id: '__xr__' };
  ctx.graph.addResource(xrRef);

  const statusProxy = new Proxy(xrDesiredStatus, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const key = String(prop);
      // Desired-first
      if (key in xrDesiredStatus) return xrDesiredStatus[key];
      // Fallback to observed status
      const observedStatus = xrObserved.status as Record<string, unknown> | undefined;
      if (observedStatus && key in observedStatus) {
        return observedStatus[key];
      }
      return undefined;
    },
    set(_target, prop, value) {
      if (typeof prop === 'symbol') return false;
      xrDesiredStatus[String(prop)] = value;
      return true;
    },
    has(_target, prop) {
      if (typeof prop === 'symbol') return false;
      const key = String(prop);
      if (key in xrDesiredStatus) return true;
      const observedStatus = xrObserved.status as Record<string, unknown> | undefined;
      return observedStatus ? key in observedStatus : false;
    },
  });

  const proxy = new Proxy({} as XrProxy<TSpec, TStatus>, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const key = String(prop);
      if (key === 'status') return statusProxy;
      // Everything else reads from observed XR
      if (key in xrObserved) return xrObserved[key];
      return undefined;
    },
    set(_target, prop, value) {
      if (typeof prop === 'symbol') return false;
      const key = String(prop);
      if (key === 'status') {
        // Allow replacing entire status
        Object.assign(xrDesiredStatus, value as object);
        return true;
      }
      // Writes to other top-level XR fields are unusual but allowed
      (xrObserved as Record<string, unknown>)[key] = value;
      return true;
    },
    has(_target, prop) {
      if (typeof prop === 'symbol') return false;
      return String(prop) in xrObserved || String(prop) === 'status';
    },
  });

  return proxy;
}

/**
 * Extract the desired XR status from a Composition instance.
 * Used by the emit pipeline phase to produce composite status output.
 */
export function getXrDesiredStatus(composition: Composition): Record<string, unknown> {
  // Access the internal status proxy target
  const statusProxy = composition.xr.status;
  // Collect all keys from the status proxy.
  // We intentionally return raw values (including ReadProxy references) so
  // that the emit phase can resolve them from observed resource data.
  const result: Record<string, unknown> = {};
  if (statusProxy && typeof statusProxy === 'object') {
    for (const key of Object.keys(statusProxy)) {
      const value = (statusProxy as Record<string, unknown>)[key];
      if (value != null) {
        result[key] = value;
      }
    }
  }
  return result;
}
