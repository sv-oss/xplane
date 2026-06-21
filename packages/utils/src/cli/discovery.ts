import { ApiextensionsV1Api, type KubeConfig } from '@kubernetes/client-node';

/** Resolved API resource metadata. */
export interface ResolvedResource {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

let crdCache: WeakMap<KubeConfig, Promise<ResolvedResource[]>> | undefined;

/**
 * Fetch the cluster's CRDs and project them into a flat list of resolved
 * resources (one entry per served version). Cached per `KubeConfig` instance.
 */
export async function listCrdResources(kc: KubeConfig): Promise<ResolvedResource[]> {
  crdCache ??= new WeakMap();
  const cached = crdCache.get(kc);
  if (cached) return cached;
  const promise = fetchCrdResources(kc).catch((err) => {
    crdCache?.delete(kc);
    throw err;
  });
  crdCache.set(kc, promise);
  return promise;
}

async function fetchCrdResources(kc: KubeConfig): Promise<ResolvedResource[]> {
  const api = kc.makeApiClient(ApiextensionsV1Api);
  const list = await api.listCustomResourceDefinition();
  const out: ResolvedResource[] = [];
  for (const item of list.items ?? []) {
    const spec = item.spec;
    if (!spec?.group || !spec.names?.kind || !spec.names.plural) continue;
    const namespaced = spec.scope === 'Namespaced';
    for (const v of spec.versions ?? []) {
      if (!v.name || v.served === false) continue;
      out.push({
        group: spec.group,
        version: v.name,
        kind: spec.names.kind,
        plural: spec.names.plural,
        namespaced,
      });
    }
  }
  return out;
}

/**
 * Resolve a `<resource>[.group][.version]` user hint to a single CRD-backed
 * resource. Throws when nothing matches or when the hint is ambiguous.
 */
export async function resolveResource(
  kc: KubeConfig,
  hint: { resource: string; group?: string; version?: string },
): Promise<ResolvedResource> {
  const all = await listCrdResources(kc);
  const r = hint.resource.toLowerCase();
  const matches = all.filter((c) => {
    const kindLc = c.kind.toLowerCase();
    const pluralLc = c.plural.toLowerCase();
    if (kindLc !== r && pluralLc !== r) return false;
    if (hint.group !== undefined && c.group !== hint.group) return false;
    if (hint.version !== undefined && c.version !== hint.version) return false;
    return true;
  });
  if (matches.length === 0) {
    const detail = [hint.resource, hint.group, hint.version].filter(Boolean).join('.');
    throw new Error(`No CRD found matching "${detail}". Available kinds: ${summarise(all)}.`);
  }
  if (matches.length > 1) {
    if (hint.version === undefined) {
      const grouped = new Map<string, ResolvedResource[]>();
      for (const m of matches)
        grouped.set(`${m.group}/${m.kind}`, [...(grouped.get(`${m.group}/${m.kind}`) ?? []), m]);
      if (grouped.size === 1) {
        // Multiple served versions of the same kind/group — pick the lexicographically highest.
        const sorted = [...matches].sort((a, b) => b.version.localeCompare(a.version));
        return sorted[0] as ResolvedResource;
      }
    }
    const candidates = matches.map((m) => `${m.plural}.${m.version}.${m.group}`).join(', ');
    throw new Error(
      `Ambiguous resource hint "${hint.resource}". Candidates: ${candidates}. Disambiguate with .group or .version.group.`,
    );
  }
  return matches[0] as ResolvedResource;
}

function summarise(all: ResolvedResource[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of all) {
    const k = `${r.plural}.${r.group}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 20) {
      out.push('…');
      break;
    }
  }
  return out.join(', ');
}
