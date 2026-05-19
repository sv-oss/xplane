/**
 * Context keys used to propagate tracking infrastructure through the construct tree.
 * Set by Composition (root), read by Resource and other constructs.
 * @internal
 */
export const CONTEXT_COLLECTOR = 'xplane:collector';
export const CONTEXT_GRAPH = 'xplane:graph';
/** Raw XR name and namespace stored at composition root for use by uniqueName. */
export const CONTEXT_XR_META = 'xplane:xr-meta';
/** Registry of existing resource references on the composition root. */
export const CONTEXT_EXISTING = 'xplane:existing';
/** Pre-populated required resources data for existing resources. */
export const CONTEXT_REQUIRED_RESOURCES = 'xplane:required-resources';
