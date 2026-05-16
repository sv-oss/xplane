/**
 * Context keys used to propagate tracking infrastructure through the construct tree.
 * Set by Composition (root), read by Resource and other constructs.
 * @internal
 */
export const CONTEXT_COLLECTOR = "xplane:collector";
export const CONTEXT_GRAPH = "xplane:graph";
/** Raw XR name and namespace stored at composition root for use by uniqueName. */
export const CONTEXT_XR_META = "xplane:xr-meta";
