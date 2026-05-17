import type { DependencyEdge, ResourceRef } from './types.js';

/**
 * Directed acyclic graph of resource dependencies.
 * Supports topological sorting to determine resource creation order
 * and cycle detection to surface configuration errors.
 */
export class DependencyGraph {
  /** adjacency list: resource id → set of resource ids it depends on */
  private readonly _deps = new Map<string, Set<string>>();
  /** all registered resource refs by id */
  private readonly _resources = new Map<string, ResourceRef>();
  /** raw edges for introspection */
  private readonly _edges: DependencyEdge[] = [];

  /** Register a resource node in the graph. */
  addResource(ref: ResourceRef): void {
    this._resources.set(ref.id, ref);
    if (!this._deps.has(ref.id)) {
      this._deps.set(ref.id, new Set());
    }
  }

  /** Add dependency edges from the collector. */
  addEdges(edges: ReadonlyArray<DependencyEdge>): void {
    for (const edge of edges) {
      this.addResource(edge.from);
      this.addResource(edge.to);

      // edge.to depends on edge.from
      const deps = this._deps.get(edge.to.id);
      if (deps) {
        deps.add(edge.from.id);
      }

      this._edges.push(edge);
    }
  }

  /** Add an explicit dependency: `dependent` depends on `dependency`. */
  addExplicitDependency(dependent: ResourceRef, dependency: ResourceRef): void {
    this.addResource(dependent);
    this.addResource(dependency);
    const deps = this._deps.get(dependent.id);
    if (deps) {
      deps.add(dependency.id);
    }
  }

  /** Get all resource IDs that `resourceId` directly depends on. */
  getDependencies(resourceId: string): ReadonlySet<string> {
    return this._deps.get(resourceId) ?? new Set();
  }

  /** Get all registered resource IDs. */
  get resourceIds(): ReadonlyArray<string> {
    return [...this._resources.keys()];
  }

  /** Get all raw edges. */
  get edges(): ReadonlyArray<DependencyEdge> {
    return this._edges;
  }

  /**
   * Returns resource IDs in topological order (dependencies first).
   * Throws if the graph contains cycles.
   */
  topologicalSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: string[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const cycle = [...visiting, id].join(' → ');
        throw new Error(`Dependency cycle detected: ${cycle}`);
      }

      visiting.add(id);

      const deps = this._deps.get(id);
      if (deps) {
        for (const depId of deps) {
          visit(depId);
        }
      }

      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
    };

    for (const id of this._resources.keys()) {
      visit(id);
    }

    return sorted;
  }
}
