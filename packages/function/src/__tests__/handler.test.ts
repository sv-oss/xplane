import {
  fromObject,
  type Logger,
  type RunFunctionRequest,
  type RunFunctionResponse,
} from '@crossplane-org/function-sdk-typescript';
import type { CompositionModule, CompositionResult } from '@xplane/core';
import { describe, expect, it, vi } from 'vitest';
import { CompositionHandler } from '../handler.js';
import type { CompositionLoader } from '../loader/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<RunFunctionRequest> = {}): RunFunctionRequest {
  return {
    meta: { tag: 'test', capabilities: [] },
    observed: {
      composite: fromObject({
        apiVersion: 'test.io/v1',
        kind: 'TestXR',
        metadata: { name: 'test-xr' },
        spec: { region: 'us-east-1' },
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
    ...overrides,
  };
}

function makeLoader(mod: CompositionModule): CompositionLoader {
  return {
    name: 'test',
    async load() {
      return mod;
    },
  };
}

function getResultMessage(rsp: RunFunctionResponse): string | undefined {
  return rsp.results?.[0]?.message;
}

function getResultSeverity(rsp: RunFunctionResponse): number | undefined {
  return rsp.results?.[0]?.severity;
}

function mockLogger(): Logger {
  const childLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue(childLogger),
  } as unknown as Logger;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CompositionHandler', () => {
  const emptyResult: CompositionResult = {
    resources: [],
    blockedResources: [],
    externalResources: [],
    xrStatus: {},
    diagnostics: [],
  };

  it('returns a successful response for an empty composition', async () => {
    const handler = new CompositionHandler(makeLoader({ run: () => emptyResult }));
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toBe('Composition rendered successfully');
    expect(getResultSeverity(rsp)).not.toBe(1); // not FATAL
  });

  it('emits desired resources from the result', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        resources: [
          {
            name: 'my-cm',
            document: {
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: { name: 'test' },
              data: { key: 'val' },
            },
            ready: true,
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(rsp.desired?.resources?.['my-cm']).toBeDefined();
    expect(rsp.desired?.resources?.['my-cm']?.ready).toBe(1); // READY_TRUE
  });

  it('reports diagnostics as normal result when not at max iterations', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toContain('Waiting for external resources');
  });

  it('reports fatal when loader fails', async () => {
    const loader: CompositionLoader = {
      name: 'broken',
      async load() {
        throw new Error('bad code');
      },
    };
    const handler = new CompositionHandler(loader);
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toContain('Failed to load composition');
    expect(getResultSeverity(rsp)).toBe(1); // FATAL
  });

  it('reports fatal when module.run throws', async () => {
    const mod: CompositionModule = {
      run: () => {
        throw new Error('boom');
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toContain('Composition failed: boom');
    expect(getResultSeverity(rsp)).toBe(1); // FATAL
  });

  it('logs stack traces when module.run throws', async () => {
    const mod: CompositionModule = {
      run: () => {
        throw new Error('boom');
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const logger = mockLogger();
    await handler.RunFunction(makeRequest(), logger);
    const childError = (logger.child as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value
      .error as ReturnType<typeof vi.fn>;
    expect(childError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Composition run threw',
    );
  });

  it('logs stack traces when loader throws', async () => {
    const loader: CompositionLoader = {
      name: 'broken',
      async load() {
        throw new Error('bad code');
      },
    };
    const handler = new CompositionHandler(loader);
    const logger = mockLogger();
    await handler.RunFunction(makeRequest(), logger);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to load composition',
    );
  });

  it('catches unexpected errors and returns a fatal response with stack trace logging', async () => {
    // Simulate an error thrown after module.run returns — e.g. result.blockedResources
    // missing — by returning a result with a non-iterable blockedResources field.
    const badResult = {
      resources: [],
      blockedResources: undefined,
      externalResources: [],
      xrStatus: {},
      diagnostics: [],
    } as unknown as CompositionResult;
    const handler = new CompositionHandler(makeLoader({ run: () => badResult }));
    const logger = mockLogger();
    const rsp = await handler.RunFunction(makeRequest(), logger);
    expect(getResultMessage(rsp)).toContain('Internal error:');
    expect(getResultSeverity(rsp)).toBe(1); // FATAL
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Composition handler failed',
    );
  });

  it('passes XR spec from request into composition input', async () => {
    let capturedInput: unknown;
    const mod: CompositionModule = {
      run: (input) => {
        capturedInput = input;
        return emptyResult;
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    await handler.RunFunction(makeRequest());
    expect((capturedInput as { xr: Record<string, unknown> }).xr.spec).toEqual({
      region: 'us-east-1',
    });
  });

  it('applies XR status patches to desired composite', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        xrStatus: { conditions: [{ type: 'Ready', status: 'True' }] },
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(rsp.desired?.composite?.resource?.status).toEqual({
      conditions: [{ type: 'Ready', status: 'True' }],
    });
  });

  it('emits requireResource for external resources', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        externalResources: [
          { refKey: 'vpc-ref', apiVersion: 'ec2.aws/v1', kind: 'VPC', name: 'my-vpc' },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(
      (rsp as unknown as { requirements?: { resources?: Record<string, unknown> } }).requirements
        ?.resources?.['vpc-ref'],
    ).toBeDefined();
  });

  it('emits requireResource with namespace when provided', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        externalResources: [
          {
            refKey: 'secret-ref',
            apiVersion: 'v1',
            kind: 'Secret',
            name: 'my-secret',
            namespace: 'prod',
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(
      (rsp as unknown as { requirements?: { resources?: Record<string, unknown> } }).requirements
        ?.resources?.['secret-ref'],
    ).toBeDefined();
  });

  it('formats cycle diagnostic messages', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'a',
            reason: 'cycle' as const,
            cycle: ['a', 'b', 'a'],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toContain('circular dependency');
    expect(getResultMessage(rsp)).toContain('a → b → a');
  });

  it('formats not-found diagnostic messages', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'my-secret',
            reason: 'not-found' as const,
            detail: 'Secret not found in cluster',
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toContain('Secret not found in cluster');
  });

  it('formats not-found diagnostic without detail', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'my-secret',
            reason: 'not-found' as const,
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(getResultMessage(rsp)).toContain("External resource 'my-secret' was not found");
  });

  it('reports fatal after max iterations', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    // Simulate iteration 5 via context key (iteration becomes value + 1)
    const req = makeRequest();
    (req as unknown as { context: Record<string, unknown> }).context = {
      'xplane.function.iteration': 4,
    };
    const rsp = await handler.RunFunction(req);
    // Should be fatal since iteration >= MAX_ITERATIONS
    expect(getResultMessage(rsp)).toContain('Max iterations');
    expect(getResultSeverity(rsp)).toBe(1); // FATAL
  });

  it('extracts pipeline context from request', async () => {
    let capturedInput: unknown;
    const mod: CompositionModule = {
      run: (input) => {
        capturedInput = input;
        return emptyResult;
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const req = makeRequest();
    (req as unknown as { context: Record<string, unknown> }).context = {
      environment: 'prod',
      region: 'us-east-1',
    };
    await handler.RunFunction(req);
    const input = capturedInput as { pipelineContext: Record<string, unknown> };
    expect(input.pipelineContext.environment).toBe('prod');
    expect(input.pipelineContext.region).toBe('us-east-1');
  });

  it('extracts observed composed resources', async () => {
    let capturedInput: unknown;
    const mod: CompositionModule = {
      run: (input) => {
        capturedInput = input;
        return emptyResult;
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    await handler.RunFunction(
      makeRequest({
        observed: {
          composite: fromObject({
            apiVersion: 'test.io/v1',
            kind: 'TestXR',
            metadata: { name: 'xr' },
            spec: {},
            status: {},
          }),
          resources: {
            vpc: fromObject({
              apiVersion: 'ec2.aws/v1',
              kind: 'VPC',
              metadata: { name: 'vpc-123' },
              status: { atProvider: { vpcId: 'vpc-abc' } },
            }),
          },
        },
      }),
    );
    const input = capturedInput as { observedComposed: Record<string, Record<string, unknown>> };
    expect(input.observedComposed['Composition/vpc']).toBeDefined();
    expect(input.observedComposed['Composition/vpc']!.status).toEqual({
      atProvider: { vpcId: 'vpc-abc' },
    });
  });

  it('marks resources as not ready when ready is false', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        resources: [
          {
            name: 'my-cm',
            document: { apiVersion: 'v1', kind: 'ConfigMap' },
            ready: false,
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    expect(rsp.desired?.resources?.['my-cm']?.ready).toBe(0); // READY_UNSPECIFIED
  });

  it('handles request with no observed composite', async () => {
    let capturedInput: unknown;
    const mod: CompositionModule = {
      run: (input) => {
        capturedInput = input;
        return emptyResult;
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    await handler.RunFunction(
      makeRequest({
        observed: { composite: undefined, resources: {} },
      }),
    );
    const input = capturedInput as { xr: Record<string, unknown> };
    expect(input.xr).toEqual({ spec: {}, status: {} });
  });

  it('extracts observed required resources from request', async () => {
    let capturedInput: unknown;
    const mod: CompositionModule = {
      run: (input) => {
        capturedInput = input;
        return emptyResult;
      },
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const req = makeRequest();
    req.requiredResources = {
      'secret-ref': {
        items: [
          fromObject({
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: 'db-creds', namespace: 'default' },
            data: { password: 'abc123' },
          }),
        ],
      },
    };
    await handler.RunFunction(req);
    const input = capturedInput as { observedRequired: Record<string, Record<string, unknown>> };
    expect(input.observedRequired['secret-ref']).toBeDefined();
    expect(input.observedRequired['secret-ref']!.data).toEqual({ password: 'abc123' });
  });

  it('handles XR with namespace in identity logging', async () => {
    const logger = mockLogger();
    const handler = new CompositionHandler(makeLoader({ run: () => emptyResult }));
    const rsp = await handler.RunFunction(
      makeRequest({
        observed: {
          composite: fromObject({
            apiVersion: 'test.io/v1',
            kind: 'TestXR',
            metadata: { name: 'ns-xr', namespace: 'my-ns' },
            spec: {},
            status: {},
          }),
          resources: {},
        },
      }),
      logger,
    );
    expect(getResultMessage(rsp)).toBe('Composition rendered successfully');
  });

  it('logs pipeline completion when logger is provided', async () => {
    const logger = mockLogger();
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        resources: [
          {
            name: 'test-res',
            document: { apiVersion: 'v1', kind: 'ConfigMap' },
            ready: true,
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    await handler.RunFunction(makeRequest(), logger);
    const childLogger = (logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(childLogger.info).toHaveBeenCalled();
  });

  it('logs diagnostic details with logger', async () => {
    const logger = mockLogger();
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest(), logger);
    expect(getResultMessage(rsp)).toContain('Waiting for external resources');
  });

  it('logs external resource debug info', async () => {
    const logger = mockLogger();
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        externalResources: [
          {
            refKey: 'vpc-ref',
            apiVersion: 'ec2.aws/v1',
            kind: 'VPC',
            name: 'my-vpc',
            namespace: 'default',
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    await handler.RunFunction(makeRequest(), logger);
    const childLogger = (logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(childLogger.debug).toHaveBeenCalled();
  });

  it('logs XR status patches when present', async () => {
    const logger = mockLogger();
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        xrStatus: { ready: true },
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    await handler.RunFunction(makeRequest(), logger);
    const childLogger = (logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(childLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ xrStatus: { ready: true } }),
      'XR status patches',
    );
  });

  it('preserves observed blocked resources in desired with READY_FALSE', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        blockedResources: ['subnet'],
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(
      makeRequest({
        observed: {
          composite: fromObject({
            apiVersion: 'test.io/v1',
            kind: 'TestXR',
            metadata: { name: 'test-xr' },
            spec: {},
            status: {},
          }),
          resources: {
            subnet: fromObject({
              apiVersion: 'ec2.aws/v1',
              kind: 'Subnet',
              metadata: { name: 'my-subnet' },
              spec: { forProvider: { vpcId: 'old-vpc' } },
            }),
          },
        },
      }),
    );
    // Blocked resource preserved in desired with READY_FALSE (2)
    expect(rsp.desired?.resources?.subnet).toBeDefined();
    expect(rsp.desired?.resources?.subnet?.ready).toBe(2); // READY_FALSE
  });

  it('does not add blocked resource to desired when not previously observed', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        blockedResources: ['new-subnet'],
        diagnostics: [
          {
            resource: 'new-subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest()); // no observed resources
    expect(rsp.desired?.resources?.['new-subnet']).toBeUndefined();
  });

  it('marks preserved resource as READY_FALSE when pipeline emits it as preserved', async () => {
    const observedDocument = {
      apiVersion: 'ec2.aws/v1',
      kind: 'Subnet',
      metadata: { name: 'my-subnet' },
      spec: { forProvider: { vpcId: 'old-vpc' } },
    };
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        resources: [
          {
            name: 'subnet',
            document: observedDocument,
            ready: false,
            preserved: true,
          },
        ],
        blockedResources: ['subnet'],
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    // Preserved resource must be in desired with READY_FALSE
    expect(rsp.desired?.resources?.subnet).toBeDefined();
    expect(rsp.desired?.resources?.subnet?.ready).toBe(2); // READY_FALSE
  });

  it('injects Ready=False condition on XR when there are diagnostics', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    const conditions = rsp.desired?.composite?.resource?.status?.conditions as
      | { type: string; status: string; reason: string }[]
      | undefined;
    expect(conditions).toBeDefined();
    const readyCondition = conditions?.find((c) => c.type === 'Ready');
    expect(readyCondition?.status).toBe('False');
    expect(readyCondition?.reason).toBe('Waiting');
  });

  it('merges Ready=False with existing xrStatus conditions', async () => {
    const mod: CompositionModule = {
      run: () => ({
        ...emptyResult,
        xrStatus: { conditions: [{ type: 'Synced', status: 'True' }], lastAppliedAt: 'now' },
        diagnostics: [
          {
            resource: 'subnet',
            reason: 'pending' as const,
            pendingPaths: [
              {
                path: 'spec.forProvider.vpcId',
                waitingOn: { resource: 'vpc', path: 'status.atProvider.vpcId' },
              },
            ],
          },
        ],
      }),
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    const status = rsp.desired?.composite?.resource?.status as Record<string, unknown> | undefined;
    expect(status?.lastAppliedAt).toBe('now');
    const conditions = status?.conditions as { type: string; status: string }[] | undefined;
    expect(conditions?.find((c) => c.type === 'Synced')?.status).toBe('True');
    expect(conditions?.find((c) => c.type === 'Ready')?.status).toBe('False');
  });

  it('does not inject Ready=False when there are no diagnostics', async () => {
    const mod: CompositionModule = {
      run: () => emptyResult,
    };
    const handler = new CompositionHandler(makeLoader(mod));
    const rsp = await handler.RunFunction(makeRequest());
    // No xrStatus set at all when result is clean
    expect(rsp.desired?.composite?.resource?.status).toBeUndefined();
  });
});
