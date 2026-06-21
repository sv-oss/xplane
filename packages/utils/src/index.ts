export { type LoadKubeConfigOptions, loadKubeConfig } from './client/kubeconfig.js';
export { type AwaitReadyOptions, awaitReady } from './watcher/await-ready.js';
export { buildSnapshot } from './watcher/readiness.js';
export { type ParsedTarget, parseTarget } from './watcher/target.js';
export {
  buildTree,
  type ResourceTree,
  type TreeNode,
  type TreeStats,
} from './watcher/tree.js';
export type {
  BlockedResource,
  EmittedResource,
  KubernetesEvent,
  ResourceRef,
  XplaneStatus,
  XrEvent,
  XrRef,
  XrSnapshot,
} from './watcher/types.js';
export {
  type CreateXrWatcherOptions,
  createXrWatcher,
  type XrWatcher,
} from './watcher/xr-watcher.js';
