export { Construct } from 'constructs';
export {
  Composition,
  getXrDesiredStatus,
  type PipelineContextAccessor,
  type XrProxy,
} from './composition.js';
export { type CompositionContext, compositionStorage, getCompositionContext } from './context.js';
export {
  computeLabelRefKey,
  computeLogicalId,
  computeRefKey,
  type ExternalResourceRef,
  getDesiredDocument,
  getExternalRef,
  getObservedDocument,
  getReadyChecks,
  getResourceInternals,
  getResourceRef,
  HIDDEN_ID,
  hasUnresolvedLabels,
  hydrateObserved,
  isExternal,
  type KubernetesResource,
  pickSingle,
  Resource,
  type ResourceConfig,
  type ResourceProps,
} from './resource.js';
