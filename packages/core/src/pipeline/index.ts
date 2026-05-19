import type { Composition } from '../core/composition.js';
import type { Resource } from '../core/resource.js';

import { diagnose } from './diagnose.js';
import { emit } from './emit.js';
import { hydrate } from './hydrate.js';
import { resolve } from './resolve.js';
import { sequence } from './sequence.js';
import type { PipelineState } from './types.js';

export { diagnose } from './diagnose.js';
export { emit } from './emit.js';
export { hydrate } from './hydrate.js';
export { resolve } from './resolve.js';
export { sequence } from './sequence.js';
export type {
  DiagnosticReport,
  EmittedResource,
  PipelineState,
  ResourceClassification,
} from './types.js';

/**
 * Input to the pipeline — provided by the handler or simulator.
 */
export interface PipelineInput {
  /** The constructed Composition instance. */
  composition: Composition;
  /** Observed composed resources from Crossplane (keyed by resource name). */
  observedComposed: ReadonlyMap<string, Record<string, unknown>>;
  /** Observed existing/required resources (keyed by refKey). */
  observedRequired: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * Run the full rendering pipeline.
 *
 * Phases: hydrate → resolve → sequence → diagnose → emit
 */
export function runPipeline(input: PipelineInput): PipelineState {
  const resources = collectResources(input.composition);

  const initialState: PipelineState = {
    composition: input.composition,
    resources,
    graph: input.composition.graph,
    observedComposed: input.observedComposed,
    observedRequired: input.observedRequired,
    classification: new Map(),
    diagnostics: [],
    emitted: [],
    xrStatusPatches: {},
  };

  // Run phases sequentially — each transforms the state
  let state = initialState;
  state = hydrate(state);
  state = resolve(state);
  state = sequence(state);
  state = diagnose(state);
  state = emit(state);

  return state;
}

/**
 * Collect all Resource instances from the composition's construct tree.
 */
function collectResources(composition: Composition): Resource[] {
  const resources: Resource[] = [];
  collectFromNode(composition, resources);
  return resources;
}

function collectFromNode(construct: import('constructs').Construct, resources: Resource[]): void {
  for (const child of construct.node.children) {
    // Check if it's a Resource (has our internals)
    if (isResourceInstance(child)) {
      resources.push(child as Resource);
    }
    // Recurse into children
    collectFromNode(child, resources);
  }
}

function isResourceInstance(obj: unknown): obj is Resource {
  if (obj === null || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  if (!('resource' in r) || r.resource === null || typeof r.resource !== 'object') return false;
  return 'autoReady' in (r.resource as object);
}
