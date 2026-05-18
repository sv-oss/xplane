export { DependencyGraph } from './dependency-graph.js';
export {
  createTrackedProxy,
  DependencyCollector,
  getTrackingMeta,
  isTracked,
  UNRESOLVED,
} from './proxy.js';
export type { DependencyEdge, ExistingResourceRef, ResourceRef, TrackingMeta } from './types.js';
export { IS_TRACKED, TRACKING_META } from './types.js';
