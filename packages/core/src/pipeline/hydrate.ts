import { getExternalRef, hydrateObserved, isExternal, pickSingle } from '../core/resource.js';

import type { PipelineState } from './types.js';

/**
 * HYDRATE phase: feed observed state from Crossplane into each resource.
 *
 * - Composed resources are matched by their construct path (resource name).
 * - External resources are matched by their refKey; label selectors use pickSingle.
 */
export function hydrate(state: PipelineState): PipelineState {
  for (const resource of state.resources) {
    if (isExternal(resource)) {
      const ref = getExternalRef(resource);
      if (ref) {
        const list = state.observedRequired.get(ref.refKey);
        if (list) {
          const observed = pickSingle(list, ref.refKey);
          if (observed) hydrateObserved(resource, observed);
        }
      }
    } else {
      const name = resource.node.path;
      const observed = state.observedComposed.get(name);
      if (observed) {
        hydrateObserved(resource, observed);
      }
    }
  }

  return state;
}
