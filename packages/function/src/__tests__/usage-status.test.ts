import { fromObject, type RunFunctionRequest } from '@crossplane-org/function-sdk-typescript';
import {
  type CompositionModule,
  type CompositionResult,
  SYNTHETIC_ANNOTATION_KEY,
  SYNTHETIC_USAGE_VALUE,
} from '@xplane/core';
import { describe, expect, it } from 'vitest';
import { CompositionHandler } from '../handler.js';
import type { CompositionLoader } from '../loader/types.js';
import { isSyntheticUsageDoc } from '../usage-status.js';

function makeRequest(): RunFunctionRequest {
  return {
    meta: { tag: 'test', capabilities: [] },
    observed: {
      composite: fromObject({
        apiVersion: 'test.io/v1',
        kind: 'TestXR',
        metadata: { name: 'test-xr' },
        spec: {},
        status: {},
      }),
      resources: {},
    },
    desired: { composite: undefined, resources: {} },
    input: undefined,
    context: {},
    extraResources: {},
    credentials: {},
    requiredResources: {},
    requiredSchemas: {},
  };
}

function makeLoader(mod: CompositionModule): CompositionLoader {
  return { name: 'test', load: () => Promise.resolve(mod) };
}

function syntheticUsage(name: string): Record<string, unknown> {
  return {
    apiVersion: 'protection.crossplane.io/v1beta1',
    kind: 'ClusterUsage',
    metadata: {
      name,
      annotations: { [SYNTHETIC_ANNOTATION_KEY]: SYNTHETIC_USAGE_VALUE },
    },
    spec: {
      of: { apiVersion: 'v1', kind: 'VPC', resourceRef: { name: 'vpc' } },
      by: { apiVersion: 'v1', kind: 'Subnet', resourceRef: { name: 'sn' } },
      reason: 'xplane: Subnet/sn needs VPC/vpc',
    },
  };
}

function authoredCm(name: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name },
    data: { k: 'v' },
  };
}

function baseResult(overrides: Partial<CompositionResult>): CompositionResult {
  return {
    resources: [],
    blockedResources: [],
    externalResources: [],
    xrStatus: {},
    diagnostics: [],
    emitXplaneStatus: true,
    usageStatusVisible: true,
    ...overrides,
  };
}

function readXplaneStatus(rsp: {
  desired?: { composite?: { resource?: Record<string, unknown> } };
}): {
  emittedResources: Array<Record<string, unknown>>;
} {
  const status = rsp.desired?.composite?.resource?.status as Record<string, unknown>;
  return status.xplane as { emittedResources: Array<Record<string, unknown>> };
}

describe('isSyntheticUsageDoc', () => {
  it('returns true for a stamped synthetic usage doc', () => {
    expect(isSyntheticUsageDoc(syntheticUsage('a'))).toBe(true);
  });

  it('returns false for an author-emitted doc', () => {
    expect(isSyntheticUsageDoc(authoredCm('a'))).toBe(false);
  });

  it('returns false when metadata is missing', () => {
    expect(isSyntheticUsageDoc({ apiVersion: 'v1', kind: 'X' })).toBe(false);
  });

  it('returns false when annotations are missing', () => {
    expect(isSyntheticUsageDoc({ apiVersion: 'v1', kind: 'X', metadata: { name: 'n' } })).toBe(
      false,
    );
  });

  it('returns false when annotations is not an object', () => {
    expect(
      isSyntheticUsageDoc({
        apiVersion: 'v1',
        kind: 'X',
        metadata: { name: 'n', annotations: 'not-an-object' },
      }),
    ).toBe(false);
  });
});

describe('handler filters synthetic usages from status.xplane.emittedResources', () => {
  it('applies usage docs as composed resources regardless of usageStatusVisible', async () => {
    const result = baseResult({
      resources: [
        {
          nodePath: 'cm',
          name: 'cm',
          document: authoredCm('cm'),
          ready: true,
        },
        {
          nodePath: '__usage/subnet--uses--vpc',
          document: syntheticUsage('subnet--uses--vpc'),
          ready: true,
        },
      ],
      usageStatusVisible: false,
    });
    const handler = new CompositionHandler(makeLoader({ run: () => result }));
    const rsp = await handler.RunFunction(makeRequest());
    const desired = rsp.desired?.resources ?? {};
    expect(Object.keys(desired).sort()).toEqual(['__usage/subnet--uses--vpc', 'cm']);
  });

  it('includes synthetic usages in status.xplane.emittedResources by default', async () => {
    const result = baseResult({
      resources: [
        { nodePath: 'cm', document: authoredCm('cm'), ready: true },
        {
          nodePath: '__usage/subnet--uses--vpc',
          document: syntheticUsage('subnet--uses--vpc'),
          ready: true,
        },
      ],
    });
    const handler = new CompositionHandler(makeLoader({ run: () => result }));
    const rsp = await handler.RunFunction(makeRequest());
    const status = readXplaneStatus(rsp);
    const kinds = status.emittedResources.map((r) => r.kind).sort();
    expect(kinds).toEqual(['ClusterUsage', 'ConfigMap']);
  });

  it('filters synthetic usages out of status.xplane.emittedResources when usageStatusVisible is false', async () => {
    const result = baseResult({
      resources: [
        { nodePath: 'cm', document: authoredCm('cm'), ready: true },
        {
          nodePath: '__usage/subnet--uses--vpc',
          document: syntheticUsage('subnet--uses--vpc'),
          ready: true,
        },
      ],
      usageStatusVisible: false,
    });
    const handler = new CompositionHandler(makeLoader({ run: () => result }));
    const rsp = await handler.RunFunction(makeRequest());
    const status = readXplaneStatus(rsp);
    const kinds = status.emittedResources.map((r) => r.kind);
    expect(kinds).toEqual(['ConfigMap']);
  });
});
