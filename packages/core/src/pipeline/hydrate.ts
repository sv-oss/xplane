import { getExternalRef, hydrateObserved, isExternal } from '../core/resource.js';

import type { PipelineState } from './types.js';

/**
 * HYDRATE phase: feed observed state from Crossplane into each resource.
 *
 * - Composed resources are matched by their construct path (resource name).
 * - External resources are matched by their refKey.
 */
export function hydrate(state: PipelineState): PipelineState {
  for (const resource of state.resources) {
    if (isExternal(resource)) {
      const ref = getExternalRef(resource);
      if (ref) {
        const observed = state.observedRequired.get(ref.refKey);
        if (observed) {
          hydrateObserved(resource, observed);
        }
      }
    } else {
      // Match by construct path
      const name = resource.node.path;
      const observed = state.observedComposed.get(name);
      if (observed) {
        hydrateObserved(resource, observed);
      }
    }
  }

  return state;
}
