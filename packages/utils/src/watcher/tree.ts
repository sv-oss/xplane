import type { BlockedResource, EmittedResource, XrSnapshot } from './types.js';

/**
 * A node in the construct-derived resource tree.
 *
 * Resource names emitted by compositions encode their construct path with `/` as
 * the separator (e.g. `"CMS Database/Security Group"`). The tree mirrors that
 * hierarchy so renderers can indent each branch.
 */
export interface TreeNode {
  /** Last segment of the construct path (display label). */
  label: string;
  /** Full construct path (joined with `/`). */
  path: string;
  /** Kubernetes `metadata.name` of the leaf resource, when known. */
  name?: string;
  /** Kubernetes `metadata.namespace` of the leaf resource, when present. */
  namespace?: string;
  /** True when an emitted resource at this exact path is ready. */
  ready: boolean;
  /** True when this exact path appears in `blockedResources`. */
  blocked: boolean;
  /** Unresolved dependencies copied from the blocked entry. */
  waitingFor?: string[];
  /** API version of the leaf resource (if any). */
  apiVersion?: string;
  /** Kind of the leaf resource (if any). */
  kind?: string;
  /** Child nodes keyed by path segment. */
  children: TreeNode[];
}

/** Aggregate counts derived from `status.xplane`. */
export interface TreeStats {
  /** Total emitted resources. */
  total: number;
  /** Emitted resources marked ready. */
  ready: number;
  /** Blocked resources. */
  blocked: number;
}

export interface ResourceTree {
  /** Root-level nodes. */
  roots: TreeNode[];
  /** Aggregate counts. Zero values when no xplane status is available. */
  stats: TreeStats;
  /** Source used to build the tree. */
  source: 'xplane' | 'resourceRefs' | 'empty';
}

/** Build a `ResourceTree` from a snapshot, preferring `status.xplane` when present. */
export function buildTree(snapshot: XrSnapshot): ResourceTree {
  if (snapshot.xplane) {
    return fromXplane(snapshot.xplane.emittedResources, snapshot.xplane.blockedResources);
  }
  if (snapshot.resourceRefs.length > 0) {
    return fromResourceRefs(snapshot.resourceRefs);
  }
  return { roots: [], stats: { total: 0, ready: 0, blocked: 0 }, source: 'empty' };
}

function fromXplane(emitted: EmittedResource[], blocked: BlockedResource[]): ResourceTree {
  const byPath = new Map<string, TreeNode>();
  const ownEntry = new Set<string>();
  const roots: TreeNode[] = [];

  const ensureNode = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const segments = path.split('/');
    const label = segments[segments.length - 1] ?? path;
    const node: TreeNode = { label, path, ready: false, blocked: false, children: [] };
    byPath.set(path, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join('/');
      ensureNode(parentPath).children.push(node);
    }
    return node;
  };

  for (const r of emitted) {
    const node = ensureNode(r.nodePath);
    node.ready = r.ready;
    node.apiVersion = r.apiVersion;
    node.kind = r.kind;
    if (r.name) node.name = r.name;
    if (r.namespace) node.namespace = r.namespace;
    ownEntry.add(r.nodePath);
  }
  for (const b of blocked) {
    const node = ensureNode(b.nodePath);
    node.blocked = true;
    if (b.waitingFor) node.waitingFor = b.waitingFor;
    if (!node.apiVersion) node.apiVersion = b.apiVersion;
    if (!node.kind) node.kind = b.kind;
    if (!node.name && b.name) node.name = b.name;
    if (!node.namespace && b.namespace) node.namespace = b.namespace;
    ownEntry.add(b.nodePath);
  }

  // Container nodes (synthesised parents with no resource of their own) aggregate
  // readiness from their descendants: ready iff every descendant is ready and
  // none are blocked.
  const aggregate = (node: TreeNode): void => {
    for (const child of node.children) aggregate(child);
    if (!ownEntry.has(node.path) && node.children.length > 0) {
      node.ready = node.children.every((c) => c.ready);
      node.blocked = node.children.some((c) => c.blocked);
    }
  };
  for (const root of roots) aggregate(root);

  const readyCount = emitted.reduce((n, r) => n + (r.ready ? 1 : 0), 0);
  return {
    roots,
    stats: { total: emitted.length, ready: readyCount, blocked: blocked.length },
    source: 'xplane',
  };
}

function fromResourceRefs(refs: XrSnapshot['resourceRefs']): ResourceTree {
  const roots = refs.map<TreeNode>((r) => ({
    label: r.name,
    path: r.name,
    ready: false,
    blocked: false,
    apiVersion: r.apiVersion,
    kind: r.kind,
    children: [],
  }));
  return {
    roots,
    stats: { total: refs.length, ready: 0, blocked: 0 },
    source: 'resourceRefs',
  };
}
