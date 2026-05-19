import type { DependencyEdge, ResourceRef } from './types.js';

/**
 * Tracks dependency relationships between resources as a directed acyclic graph.
 * Edges are added as resources reference each other's observed state.
 */
export class DependencyGraph {
  private readonly _adjacency = new Map<string, Set<string>>();
  private readonly _resources = new Map<string, ResourceRef>();
  private readonly _edges: DependencyEdge[] = [];

  addResource(ref: ResourceRef): void {
    this._resources.set(ref.id, ref);
    if (!this._adjacency.has(ref.id)) {
      this._adjacency.set(ref.id, new Set());
    }
  }

  addEdge(edge: DependencyEdge): void {
    this.addResource(edge.from);
    this.addResource(edge.to);
    this._adjacency.get(edge.to.id)!.add(edge.from.id);
    this._edges.push(edge);
  }

  addEdges(edges: ReadonlyArray<DependencyEdge>): void {
    for (const edge of edges) this.addEdge(edge);
  }

  addExplicitDependency(dependent: ResourceRef, dependency: ResourceRef): void {
    this.addResource(dependent);
    this.addResource(dependency);
    this._adjacency.get(dependent.id)!.add(dependency.id);
  }

  /** Get the set of resource IDs that `resourceId` depends on. */
  getDependencies(resourceId: string): ReadonlySet<string> {
    return this._adjacency.get(resourceId) ?? new Set();
  }

  get resourceIds(): ReadonlyArray<string> {
    return [...this._resources.keys()];
  }

  get edges(): ReadonlyArray<DependencyEdge> {
    return this._edges;
  }

  /**
   * Returns a topological ordering of resources.
   * If a cycle is detected, returns { order: null, cycle: string[] }.
   */
  topologicalSort(): { order: string[] } | { order: null; cycle: string[] } {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const sorted: string[] = [];

    const visit = (id: string): string[] | null => {
      if (visited.has(id)) return null;
      if (visiting.has(id)) {
        // Build cycle path
        return [...visiting, id];
      }
      visiting.add(id);
      const deps = this._adjacency.get(id);
      if (deps) {
        for (const depId of deps) {
          const cycle = visit(depId);
          if (cycle) return cycle;
        }
      }
      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
      return null;
    };

    for (const id of this._resources.keys()) {
      const cycle = visit(id);
      if (cycle) {
        // Trim cycle to start from the repeated node
        const start = cycle[cycle.length - 1]!;
        const startIdx = cycle.indexOf(start);
        return { order: null, cycle: cycle.slice(startIdx) };
      }
    }
    return { order: sorted };
  }
}
