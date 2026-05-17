// Core constructs
export {
  type AnyFields,
  Composition,
  Construct,
  type KubernetesResource,
  Resource,
  type ResourceOptions,
  type ResourceProps,
} from './core/index.js';
// Auto-ready
export { getReadyCondition, isResourceReady } from './ready/index.js';
// Sequencing
export {
  type ResolutionResult,
  resolveSequencing,
  type SequencingResult,
} from './sequencing/index.js';
// Dependency tracking
export {
  createTrackedProxy,
  DependencyCollector,
  type DependencyEdge,
  DependencyGraph,
  getTrackingMeta,
  IS_TRACKED,
  isTracked,
  type ResourceRef,
  TRACKING_META,
  type TrackingMeta,
  UNRESOLVED,
} from './tracking/index.js';
