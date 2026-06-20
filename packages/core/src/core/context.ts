import { AsyncLocalStorage } from 'node:async_hooks';

import type { DependencyGraph, EdgeCollector } from '../tracking/index.js';

/**
 * Runtime context passed into a Composition during construction
 * via AsyncLocalStorage. Holds everything the Composition needs
 * without relying on static state or globalThis.
 */
export interface CompositionContext {
  /** Observed XR data. */
  xr: Record<string, unknown>;
  /** Full Crossplane function pipeline context (all keys). */
  pipelineContext: ReadonlyMap<string, unknown>;
  /** Pre-populated data for existing resources (from prior iterations). */
  requiredResources: ReadonlyMap<string, Record<string, unknown>>;
  /** Pre-populated data for composed resources (from prior iterations), keyed by `Composition/{path}`. */
  observedComposed: ReadonlyMap<string, Record<string, unknown>>;
  /** The dependency graph for this composition run. */
  graph: DependencyGraph;
  /** The edge collector for this composition run. */
  collector: EdgeCollector;
}

/**
 * AsyncLocalStorage instance that carries the CompositionContext.
 * The handler sets it before constructing the user's Composition,
 * and the Composition constructor reads from it.
 */
export const compositionStorage = new AsyncLocalStorage<CompositionContext>();

/**
 * Get the current composition context from AsyncLocalStorage.
 * Throws if called outside of a composition construction scope.
 */
export function getCompositionContext(): CompositionContext {
  const ctx = compositionStorage.getStore();
  if (ctx) return ctx;

  throw new Error(
    'No composition context found. Ensure the Composition is constructed within compositionStorage.run().',
  );
}
