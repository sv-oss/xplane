export { Construct } from 'constructs';
export {
  Composition,
  getXrDesiredStatus,
  type PipelineContextAccessor,
  type XrProxy,
} from './composition.js';
export { type CompositionContext, compositionStorage, getCompositionContext } from './context.js';
export {
  computeRefKey,
  type ExternalResourceRef,
  getDesiredDocument,
  getExternalRef,
  getObservedDocument,
  getReadyChecks,
  getResourceInternals,
  getResourceRef,
  hydrateObserved,
  isExternal,
  type KubernetesResource,
  Resource,
  type ResourceConfig,
  type ResourceProps,
} from './resource.js';
