import { KubeConfig } from '@kubernetes/client-node';

export interface LoadKubeConfigOptions {
  /** Explicit kubeconfig file path. Falls back to `KUBECONFIG` / default discovery. */
  kubeconfig?: string;
  /** Override the active context. */
  context?: string;
}

/**
 * Load a `KubeConfig` from disk using `client-node`'s default rules (with
 * optional explicit overrides). The returned config has its current context
 * applied.
 */
export function loadKubeConfig(opts: LoadKubeConfigOptions = {}): KubeConfig {
  const kc = new KubeConfig();
  if (opts.kubeconfig) {
    kc.loadFromFile(opts.kubeconfig);
  } else {
    kc.loadFromDefault();
  }
  if (opts.context) {
    kc.setCurrentContext(opts.context);
  }
  return kc;
}
