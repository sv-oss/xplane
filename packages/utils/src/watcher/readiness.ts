import type { KubernetesObject } from '@kubernetes/client-node';
import type { ResourceRef, XplaneStatus, XrSnapshot } from './types.js';

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Build an `XrSnapshot` from a raw Kubernetes object. Parses the `Ready` condition,
 * the optional `status.xplane` payload and `status.resourceRefs`.
 */
export function buildSnapshot(object: KubernetesObject): XrSnapshot {
  const status = isRecord((object as { status?: unknown }).status)
    ? (object as { status: Record<string, unknown> }).status
    : undefined;

  const conditions: Condition[] = [];
  if (status && Array.isArray(status.conditions)) {
    for (const c of status.conditions as unknown[]) {
      if (isRecord(c)) {
        conditions.push({
          type: asString(c.type),
          status: asString(c.status),
          reason: asString(c.reason),
          message: asString(c.message),
        });
      }
    }
  }
  const ready = conditions.find((c) => c.type === 'Ready');
  const responsive = conditions.find((c) => c.type === 'Responsive');
  const synced = conditions.find((c) => c.type === 'Synced');

  const snapshot: XrSnapshot = {
    object,
    ready: ready?.status === 'True',
    resourceRefs: parseResourceRefs(status),
  };
  if (ready?.reason !== undefined) snapshot.readyReason = ready.reason;
  if (ready?.message !== undefined) snapshot.readyMessage = ready.message;
  if (responsive?.status === 'False' && responsive.reason === 'WatchCircuitOpen') {
    snapshot.updatesThrottled = true;
  }
  if (synced?.status === 'False' && synced.reason === 'ReconcileError') {
    snapshot.syncError = {
      reason: synced.reason,
      message: synced.message ?? '',
    };
  }

  const xplane = parseXplane(status);
  if (xplane) snapshot.xplane = xplane;

  return snapshot;
}

function parseResourceRefs(status: Record<string, unknown> | undefined): ResourceRef[] {
  const out: ResourceRef[] = [];
  if (!status) return out;
  const refs = status.resourceRefs;
  if (!Array.isArray(refs)) return out;
  for (const r of refs as unknown[]) {
    if (!isRecord(r)) continue;
    const apiVersion = asString(r.apiVersion) ?? '';
    const kind = asString(r.kind) ?? '';
    const name = asString(r.name) ?? '';
    if (name) out.push({ apiVersion, kind, name });
  }
  return out;
}

function parseXplane(status: Record<string, unknown> | undefined): XplaneStatus | undefined {
  if (!status || !isRecord(status.xplane)) return undefined;
  const x = status.xplane;
  const emitted: XplaneStatus['emittedResources'] = [];
  if (Array.isArray(x.emittedResources)) {
    for (const r of x.emittedResources as unknown[]) {
      if (!isRecord(r)) continue;
      const nodePath = asString(r.nodePath);
      if (!nodePath) continue;
      const name = asString(r.name);
      const namespace = asString(r.namespace);
      emitted.push({
        apiVersion: asString(r.apiVersion) ?? '',
        kind: asString(r.kind) ?? '',
        nodePath,
        ...(name ? { name } : {}),
        ...(namespace ? { namespace } : {}),
        ready: r.ready === true,
      });
    }
  }
  const blocked: XplaneStatus['blockedResources'] = [];
  if (Array.isArray(x.blockedResources)) {
    for (const r of x.blockedResources as unknown[]) {
      if (!isRecord(r)) continue;
      const nodePath = asString(r.nodePath);
      if (!nodePath) continue;
      const name = asString(r.name);
      const namespace = asString(r.namespace);
      const entry: XplaneStatus['blockedResources'][number] = {
        apiVersion: asString(r.apiVersion) ?? '',
        kind: asString(r.kind) ?? '',
        nodePath,
        ...(name ? { name } : {}),
        ...(namespace ? { namespace } : {}),
      };
      if (Array.isArray(r.waitingFor)) {
        const wf = (r.waitingFor as unknown[]).filter((s): s is string => typeof s === 'string');
        if (wf.length > 0) entry.waitingFor = wf;
      }
      blocked.push(entry);
    }
  }
  return { emittedResources: emitted, blockedResources: blocked };
}
