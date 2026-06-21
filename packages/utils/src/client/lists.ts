import {
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import type { XrRef } from '../watcher/types.js';
import type { ListResult } from './watch.js';

interface CustomObjectList {
  metadata?: { resourceVersion?: string };
  items?: KubernetesObject[];
}

/** Initial-list for a single XR via `CustomObjectsApi`, filtered by name. */
export async function listXrCollection(kc: KubeConfig, ref: XrRef): Promise<ListResult> {
  const api = kc.makeApiClient(CustomObjectsApi);
  const fieldSelector = `metadata.name=${ref.name}`;
  const res = (await (ref.namespaced && ref.namespace
    ? api.listNamespacedCustomObject({
        group: ref.group,
        version: ref.version,
        namespace: ref.namespace,
        plural: ref.plural,
        fieldSelector,
      })
    : api.listClusterCustomObject({
        group: ref.group,
        version: ref.version,
        plural: ref.plural,
        fieldSelector,
      }))) as CustomObjectList;
  return {
    resourceVersion: res.metadata?.resourceVersion ?? '',
    items: res.items ?? [],
  };
}

/** Initial-list of Kubernetes Events scoped to a namespace + field selector. */
export async function listXrEvents(
  kc: KubeConfig,
  namespace: string,
  fieldSelector: string,
): Promise<ListResult> {
  const api = kc.makeApiClient(CoreV1Api);
  const res = await api.listNamespacedEvent({ namespace, fieldSelector });
  return {
    resourceVersion: res.metadata?.resourceVersion ?? '',
    items: (res.items ?? []) as unknown as KubernetesObject[],
  };
}
