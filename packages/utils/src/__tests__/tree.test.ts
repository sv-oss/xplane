import type { KubernetesObject } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { buildTree } from '../watcher/tree.js';
import type { XrSnapshot } from '../watcher/types.js';

const baseObj = { apiVersion: 'v1', kind: 'X', metadata: { name: 'x' } } as KubernetesObject;

function snap(overrides: Partial<XrSnapshot>): XrSnapshot {
  return { object: baseObj, ready: false, resourceRefs: [], ...overrides };
}

describe('buildTree', () => {
  it('returns empty tree when nothing observed', () => {
    const t = buildTree(snap({}));
    expect(t.source).toBe('empty');
    expect(t.roots).toEqual([]);
    expect(t.stats).toEqual({ total: 0, ready: 0, blocked: 0 });
  });

  it('builds nested tree from status.xplane and merges blocked entries', () => {
    const t = buildTree(
      snap({
        xplane: {
          emittedResources: [
            { apiVersion: 'a/v1', kind: 'A', nodePath: 'CMS Database', ready: true },
            {
              apiVersion: 'a/v1',
              kind: 'B',
              nodePath: 'CMS Database/Security Group',
              ready: false,
            },
            { apiVersion: 'a/v1', kind: 'C', nodePath: 'CMS Service', ready: false },
          ],
          blockedResources: [
            {
              apiVersion: 'a/v1',
              kind: 'B',
              nodePath: 'CMS Database/Security Group',
              waitingFor: ['vpc.id'],
            },
          ],
        },
      }),
    );
    expect(t.source).toBe('xplane');
    expect(t.stats).toEqual({ total: 3, ready: 1, blocked: 1 });
    expect(t.roots).toHaveLength(2);
    const db = t.roots.find((r) => r.label === 'CMS Database');
    expect(db?.ready).toBe(true);
    expect(db?.children).toHaveLength(1);
    const sg = db?.children[0];
    expect(sg?.blocked).toBe(true);
    expect(sg?.waitingFor).toEqual(['vpc.id']);
    expect(sg?.path).toBe('CMS Database/Security Group');
  });

  it('synthesises parent nodes when only a child path is emitted', () => {
    const t = buildTree(
      snap({
        xplane: {
          emittedResources: [],
          blockedResources: [{ apiVersion: 'a/v1', kind: 'X', nodePath: 'Parent/Child' }],
        },
      }),
    );
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0]?.label).toBe('Parent');
    expect(t.roots[0]?.children[0]?.label).toBe('Child');
    expect(t.roots[0]?.children[0]?.blocked).toBe(true);
  });

  it('aggregates readiness for synthesised container parents', () => {
    const t = buildTree(
      snap({
        xplane: {
          emittedResources: [
            { apiVersion: 'a/v1', kind: 'A', nodePath: 'CMS Database/SG', ready: true },
            { apiVersion: 'a/v1', kind: 'B', nodePath: 'CMS Database/Cluster', ready: true },
            { apiVersion: 'a/v1', kind: 'C', nodePath: 'CMS FS/Mount', ready: false },
          ],
          blockedResources: [],
        },
      }),
    );
    const db = t.roots.find((r) => r.label === 'CMS Database');
    expect(db?.ready).toBe(true);
    expect(db?.blocked).toBe(false);
    const fs = t.roots.find((r) => r.label === 'CMS FS');
    expect(fs?.ready).toBe(false);
  });

  it('marks synthesised container as blocked when any descendant is blocked', () => {
    const t = buildTree(
      snap({
        xplane: {
          emittedResources: [
            { apiVersion: 'a/v1', kind: 'A', nodePath: 'Group/Ready', ready: true },
          ],
          blockedResources: [{ apiVersion: 'a/v1', kind: 'B', nodePath: 'Group/Stuck' }],
        },
      }),
    );
    const group = t.roots[0];
    expect(group?.label).toBe('Group');
    expect(group?.ready).toBe(false);
    expect(group?.blocked).toBe(true);
  });

  it('falls back to resourceRefs when status.xplane is absent', () => {
    const t = buildTree(
      snap({
        resourceRefs: [
          { apiVersion: 'aws/v1', kind: 'VPC', name: 'vpc-1' },
          { apiVersion: 'aws/v1', kind: 'Subnet', name: 'sub-1' },
        ],
      }),
    );
    expect(t.source).toBe('resourceRefs');
    expect(t.stats.total).toBe(2);
    expect(t.roots.map((r) => r.label)).toEqual(['vpc-1', 'sub-1']);
  });
});
