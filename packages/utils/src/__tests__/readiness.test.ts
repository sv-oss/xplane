import type { KubernetesObject } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../watcher/readiness.js';

function obj(status: unknown): KubernetesObject {
  return {
    apiVersion: 'platform.example.com/v1alpha1',
    kind: 'XProject',
    metadata: { name: 'foo' },
    status,
  } as unknown as KubernetesObject;
}

describe('buildSnapshot', () => {
  it('returns notReady when status is missing', () => {
    const s = buildSnapshot({
      apiVersion: 'v1',
      kind: 'X',
      metadata: { name: 'a' },
    } as KubernetesObject);
    expect(s.ready).toBe(false);
    expect(s.xplane).toBeUndefined();
    expect(s.resourceRefs).toEqual([]);
  });

  it('detects Ready=True with reason/message', () => {
    const s = buildSnapshot(
      obj({
        conditions: [{ type: 'Ready', status: 'True', reason: 'Available', message: 'all good' }],
      }),
    );
    expect(s.ready).toBe(true);
    expect(s.readyReason).toBe('Available');
    expect(s.readyMessage).toBe('all good');
  });

  it('ignores non-Ready conditions', () => {
    const s = buildSnapshot(obj({ conditions: [{ type: 'Synced', status: 'True' }] }));
    expect(s.ready).toBe(false);
    expect(s.readyReason).toBeUndefined();
  });

  it('ignores malformed condition entries', () => {
    const s = buildSnapshot(obj({ conditions: [null, 'bad', { type: 'Ready', status: 'False' }] }));
    expect(s.ready).toBe(false);
  });

  it('parses status.xplane emitted and blocked', () => {
    const s = buildSnapshot(
      obj({
        xplane: {
          emittedResources: [
            { apiVersion: 'aws/v1', kind: 'VPC', nodePath: 'VPC', name: 'vpc-1', ready: true },
            {
              apiVersion: 'aws/v1',
              kind: 'SG',
              nodePath: 'CMS Database/Security Group',
              ready: false,
            },
            'malformed',
          ],
          blockedResources: [
            {
              apiVersion: 'aws/v1',
              kind: 'Sub',
              nodePath: 'X',
              name: 'sub-x',
              waitingFor: ['vpc.id', 1],
            },
            { apiVersion: 'aws/v1', kind: 'Sub', nodePath: 'Y' },
            { apiVersion: 'aws/v1', kind: 'NoPath' },
            null,
          ],
        },
      }),
    );
    expect(s.xplane?.emittedResources).toHaveLength(2);
    expect(s.xplane?.emittedResources[0]).toEqual({
      apiVersion: 'aws/v1',
      kind: 'VPC',
      nodePath: 'VPC',
      name: 'vpc-1',
      ready: true,
    });
    expect(s.xplane?.blockedResources).toEqual([
      { apiVersion: 'aws/v1', kind: 'Sub', nodePath: 'X', name: 'sub-x', waitingFor: ['vpc.id'] },
      { apiVersion: 'aws/v1', kind: 'Sub', nodePath: 'Y' },
    ]);
  });

  it('skips xplane when not an object', () => {
    const s = buildSnapshot(obj({ xplane: 'nope' }));
    expect(s.xplane).toBeUndefined();
  });

  it('parses resourceRefs and drops malformed entries', () => {
    const s = buildSnapshot(
      obj({
        resourceRefs: [
          { apiVersion: 'aws/v1', kind: 'VPC', name: 'vpc-1' },
          { apiVersion: 'aws/v1', kind: 'SG' }, // missing name → dropped
          null,
        ],
      }),
    );
    expect(s.resourceRefs).toEqual([{ apiVersion: 'aws/v1', kind: 'VPC', name: 'vpc-1' }]);
  });

  it('ignores non-array conditions/resourceRefs', () => {
    const s = buildSnapshot(obj({ conditions: 'oops', resourceRefs: 'oops' }));
    expect(s.ready).toBe(false);
    expect(s.resourceRefs).toEqual([]);
  });
});
