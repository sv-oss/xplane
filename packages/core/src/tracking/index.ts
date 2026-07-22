export { DependencyGraph } from './dependency-graph.js';
export {
  createPrimitiveReadProxy,
  createReadProxy,
  getReadProxyMeta,
  isReadProxy,
  tagReadProxy,
} from './read-proxy.js';
export { createTokenRegistry, tokenRegistryStorage } from './token-registry.js';
export type { DependencyEdge, ReadProxyMeta, ResourceRef } from './types.js';
export { Pending, PendingMerge, PendingTemplate } from './types.js';
export {
  createLazyWriteProxy,
  createWriteProxy,
  deepProcessValue,
  EdgeCollector,
  ensureChildContainer,
  type LazyWriteProxyOptions,
  ReadOnlyResourceError,
  resolveAssignedValue,
} from './write-proxy.js';
