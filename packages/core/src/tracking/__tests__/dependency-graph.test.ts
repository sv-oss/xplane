import { describe, expect, it } from 'vitest';

import { DependencyGraph } from '../dependency-graph.js';
import type { DependencyEdge, ResourceRef } from '../types.js';

describe('DependencyGraph', () => {
  const vpc: ResourceRef = { id: 'vpc' };
  const subnet: ResourceRef = { id: 'subnet' };
  const app: ResourceRef = { id: 'app' };

  it('addResource registers a resource', () => {
    const graph = new DependencyGraph();
    graph.addResource(vpc);
    expect(graph.resourceIds).toContain('vpc');
  });

  it('addResource is idempotent', () => {
    const graph = new DependencyGraph();
    graph.addResource(vpc);
    graph.addResource(vpc);
    expect(graph.resourceIds.filter((id) => id === 'vpc')).toHaveLength(1);
  });

  it('addEdge registers both resources and records edge', () => {
    const graph = new DependencyGraph();
    const edge: DependencyEdge = {
      from: vpc,
      fromPath: 'status.vpcId',
      to: subnet,
      toPath: 'spec.vpcId',
    };
    graph.addEdge(edge);
    expect(graph.resourceIds).toContain('vpc');
    expect(graph.resourceIds).toContain('subnet');
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual(edge);
  });

  it('addEdges registers multiple edges', () => {
    const graph = new DependencyGraph();
    const edges: DependencyEdge[] = [
      { from: vpc, fromPath: 'status.vpcId', to: subnet, toPath: 'spec.vpcId' },
      { from: subnet, fromPath: 'status.subnetId', to: app, toPath: 'spec.subnetId' },
    ];
    graph.addEdges(edges);
    expect(graph.edges).toHaveLength(2);
  });

  it('addExplicitDependency creates a graph edge without field paths', () => {
    const graph = new DependencyGraph();
    graph.addExplicitDependency(subnet, vpc);
    expect(graph.getDependencies('subnet').has('vpc')).toBe(true);
  });

  it('getDependencies returns empty set for unknown resource', () => {
    const graph = new DependencyGraph();
    const deps = graph.getDependencies('unknown');
    expect(deps.size).toBe(0);
  });

  it('getDependencies returns correct dependencies', () => {
    const graph = new DependencyGraph();
    graph.addEdge({ from: vpc, fromPath: 'a', to: subnet, toPath: 'b' });
    const deps = graph.getDependencies('subnet');
    expect(deps.has('vpc')).toBe(true);
  });

  describe('topologicalSort', () => {
    it('returns correct order for linear deps', () => {
      const graph = new DependencyGraph();
      graph.addResource(vpc);
      graph.addResource(subnet);
      graph.addResource(app);
      graph.addExplicitDependency(subnet, vpc);
      graph.addExplicitDependency(app, subnet);

      const result = graph.topologicalSort();
      expect(result.order).not.toBeNull();
      const order = result.order!;
      expect(order.indexOf('vpc')).toBeLessThan(order.indexOf('subnet'));
      expect(order.indexOf('subnet')).toBeLessThan(order.indexOf('app'));
    });

    it('returns all resources with no deps in any order', () => {
      const graph = new DependencyGraph();
      graph.addResource(vpc);
      graph.addResource(subnet);
      graph.addResource(app);

      const result = graph.topologicalSort();
      expect(result.order).not.toBeNull();
      expect(result.order).toHaveLength(3);
    });

    it('detects a simple cycle', () => {
      const graph = new DependencyGraph();
      graph.addResource(vpc);
      graph.addResource(subnet);
      graph.addExplicitDependency(vpc, subnet);
      graph.addExplicitDependency(subnet, vpc);

      const result = graph.topologicalSort();
      expect(result.order).toBeNull();
      expect('cycle' in result && result.cycle.length).toBeGreaterThan(0);
    });

    it('detects a 3-node cycle', () => {
      const graph = new DependencyGraph();
      const a: ResourceRef = { id: 'a' };
      const b: ResourceRef = { id: 'b' };
      const c: ResourceRef = { id: 'c' };
      graph.addExplicitDependency(a, b);
      graph.addExplicitDependency(b, c);
      graph.addExplicitDependency(c, a);

      const result = graph.topologicalSort();
      expect(result.order).toBeNull();
      if (result.order === null) {
        expect(result.cycle.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
