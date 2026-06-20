// Core

// Contract
export type {
  BlockedResource,
  CompositionInput,
  CompositionModule,
  CompositionResult,
  DesiredResource,
  Diagnostic,
  ExternalResourceRequest,
} from './contract.js';
export {
  Composition,
  type CompositionContext,
  Construct,
  compositionStorage,
  type ExternalResourceRef,
  getCompositionContext,
  getDesiredDocument,
  getExternalRef,
  getObservedDocument,
  getReadyChecks,
  getResourceInternals,
  getResourceRef,
  getXrDesiredStatus,
  hydrateObserved,
  isExternal,
  type KubernetesResource,
  type PipelineContextAccessor,
  Resource,
  type ResourceConfig,
  type ResourceProps,
  type XrProxy,
} from './core/index.js';
// Logging
export { getLogger, withLogger, type XplaneLogger } from './logging/index.js';
// Pipeline
export {
  type DiagnosticReport,
  diagnose,
  type EmittedResource,
  emit,
  hydrate,
  type PipelineInput,
  type PipelineState,
  type ResourceClassification,
  resolve,
  runPipeline,
  sequence,
} from './pipeline/index.js';
// Readiness
export {
  DEFAULT_CHECKS,
  evaluateReadiness,
  type ReadyCheck,
  type ReadyCheckFn,
} from './readiness/index.js';
// Entry point
export { runComposition } from './run.js';
// Tracking
export {
  createPrimitiveReadProxy,
  createReadProxy,
  createTokenRegistry,
  createWriteProxy,
  type DependencyEdge,
  DependencyGraph,
  EdgeCollector,
  getReadProxyMeta,
  isReadProxy,
  Pending,
  PendingTemplate,
  type ReadProxyMeta,
  type ResourceRef,
  tokenRegistryStorage,
} from './tracking/index.js';
