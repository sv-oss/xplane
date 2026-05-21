export { DependencyGraph } from './dependency-graph.js';
export {
  createPrimitiveReadProxy,
  createReadProxy,
  getReadProxyMeta,
  isReadProxy,
} from './read-proxy.js';
export type { DependencyEdge, ReadProxyMeta, ResourceRef } from './types.js';
export { Pending } from './types.js';
export { createWriteProxy, EdgeCollector } from './write-proxy.js';
