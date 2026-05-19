import { describe, expect, it } from 'vitest';

import { DependencyGraph, EdgeCollector, Pending } from '../../tracking/index.js';
import { Composition, getXrDesiredStatus } from '../composition.js';
import { type CompositionContext, compositionStorage, getCompositionContext } from '../context.js';
import { getDesiredDocument, Resource } from '../resource.js';

function createContext(
  options: { xr?: Record<string, unknown>; pipelineContext?: Map<string, unknown> } = {},
): CompositionContext {
  return {
    xr: options.xr ?? { spec: { region: 'us-east-1' }, status: {} },
    pipelineContext: options.pipelineContext ?? new Map(),
    requiredResources: new Map(),
    graph: new DependencyGraph(),
    collector: new EdgeCollector(),
  };
}

function runInContext<T>(
  fn: () => T,
  options: { xr?: Record<string, unknown>; pipelineContext?: Map<string, unknown> } = {},
): T {
  return compositionStorage.run(createContext(options), fn);
}

describe('CompositionContext', () => {
  it('getCompositionContext throws outside of compositionStorage.run()', () => {
    expect(() => getCompositionContext()).toThrow('No composition context found');
  });

  it('getCompositionContext returns context inside run()', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      const result = getCompositionContext();
      expect(result).toBe(ctx);
    });
  });
});

describe('Composition', () => {
  it('can be constructed within compositionStorage.run()', () => {
    runInContext(() => {
      const comp = new Composition();
      expect(comp).toBeInstanceOf(Composition);
    });
  });

  it('has a graph and collector', () => {
    runInContext(() => {
      const comp = new Composition();
      expect(comp.graph).toBeInstanceOf(DependencyGraph);
      expect(comp.collector).toBeInstanceOf(EdgeCollector);
    });
  });

  describe('xr proxy', () => {
    it('reads spec from observed XR', () => {
      runInContext(
        () => {
          const comp = new Composition<{ region: string }>();
          expect(comp.xr.spec.region).toBe('us-east-1');
        },
        { xr: { spec: { region: 'us-east-1' }, status: {} } },
      );
    });

    it('reads metadata from observed XR', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect(comp.xr.metadata?.name).toBe('my-xr');
        },
        { xr: { metadata: { name: 'my-xr' }, spec: {}, status: {} } },
      );
    });

    it('writing to xr.status sets desired status', () => {
      runInContext(
        () => {
          const comp = new Composition<Record<string, unknown>, { vpcId: string }>();
          (comp.xr.status as Record<string, unknown>).vpcId = 'vpc-123';

          const status = getXrDesiredStatus(comp);
          expect(status.vpcId).toBe('vpc-123');
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('reading xr.status prefers desired over observed', () => {
      runInContext(
        () => {
          const comp = new Composition<Record<string, unknown>, { out: string }>();
          (comp.xr.status as Record<string, unknown>).out = 'desired-val';

          expect((comp.xr.status as Record<string, unknown>).out).toBe('desired-val');
        },
        { xr: { spec: {}, status: { out: 'observed-val' } } },
      );
    });

    it('reading xr.status falls through to observed if not in desired', () => {
      runInContext(
        () => {
          const comp = new Composition<Record<string, unknown>, { existing: string }>();
          expect((comp.xr.status as Record<string, unknown>).existing).toBe('obs-val');
        },
        { xr: { spec: {}, status: { existing: 'obs-val' } } },
      );
    });

    it('has() on xr.status checks both desired and observed', () => {
      runInContext(
        () => {
          const comp = new Composition();
          (comp.xr.status as Record<string, unknown>).a = 1;
          expect('a' in comp.xr.status).toBe(true);
          expect('b' in comp.xr.status).toBe(false);
        },
        { xr: { spec: {}, status: { c: 2 } } },
      );
    });

    it('returns undefined for missing top-level XR keys', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect((comp.xr as Record<string, unknown>).nonexistent).toBeUndefined();
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('has() on xr checks observed keys and status', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect('spec' in comp.xr).toBe(true);
          expect('status' in comp.xr).toBe(true);
          expect('missing' in comp.xr).toBe(false);
        },
        { xr: { spec: {} } },
      );
    });
  });

  describe('pipelineContext', () => {
    it('get() returns context values', () => {
      const ctxMap = new Map<string, unknown>([
        ['apiextensions.crossplane.io/environment', { data: { key: 'val' } }],
      ]);
      runInContext(
        () => {
          const comp = new Composition<
            Record<string, unknown>,
            Record<string, unknown>,
            { 'apiextensions.crossplane.io/environment': { data: Record<string, string> } }
          >();
          const env = comp.pipelineContext.get('apiextensions.crossplane.io/environment');
          expect(env).toEqual({ data: { key: 'val' } });
        },
        { pipelineContext: ctxMap },
      );
    });

    it('get() returns undefined for missing keys', () => {
      runInContext(() => {
        const comp = new Composition();
        expect(comp.pipelineContext.get('missing' as never)).toBeUndefined();
      });
    });

    it('has() checks existence', () => {
      const ctxMap = new Map<string, unknown>([['key1', 'value1']]);
      runInContext(
        () => {
          const comp = new Composition<
            Record<string, unknown>,
            Record<string, unknown>,
            { key1: string }
          >();
          expect(comp.pipelineContext.has('key1')).toBe(true);
        },
        { pipelineContext: ctxMap },
      );
    });

    it('keys() iterates over context keys', () => {
      const ctxMap = new Map<string, unknown>([
        ['a', 1],
        ['b', 2],
      ]);
      runInContext(
        () => {
          const comp = new Composition<
            Record<string, unknown>,
            Record<string, unknown>,
            { a: number; b: number }
          >();
          const keys = [...comp.pipelineContext.keys()];
          expect(keys).toContain('a');
          expect(keys).toContain('b');
        },
        { pipelineContext: ctxMap },
      );
    });
  });

  describe('resource creation within composition', () => {
    it('resources are children of the composition construct tree', () => {
      runInContext(() => {
        class MyComp extends Composition {
          constructor() {
            super();
            new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
            new Resource(this, 'subnet', { apiVersion: 'ec2/v1', kind: 'Subnet' });
          }
        }
        const comp = new MyComp();
        const children = comp.node.children;
        expect(children).toHaveLength(2);
      });
    });

    it('dependency edges are tracked across resources', () => {
      runInContext(() => {
        class MyComp extends Composition {
          vpc: Resource;
          subnet: Resource;
          constructor() {
            super();
            this.vpc = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
            this.subnet = new Resource(this, 'subnet', {
              apiVersion: 'ec2/v1',
              kind: 'Subnet',
              spec: {
                forProvider: {
                  vpcId: (
                    this.vpc as unknown as Record<string, Record<string, Record<string, unknown>>>
                  ).status!.atProvider!.vpcId,
                },
              },
            });
          }
        }
        const comp = new MyComp();
        expect(comp.collector.edges.length).toBeGreaterThan(0);

        // Subnet's desired should have a Pending marker
        const subnetDesired = getDesiredDocument(comp.subnet);
        const spec = subnetDesired.spec as Record<string, Record<string, unknown>>;
        expect(Pending.is(spec.forProvider!.vpcId)).toBe(true);
      });
    });
  });

  describe('xr proxy (edge cases)', () => {
    it('assigning entire status object merges into desired status', () => {
      runInContext(
        () => {
          const comp = new Composition();
          (comp.xr as Record<string, unknown>).status = { a: 1, b: 2 };
          const status = getXrDesiredStatus(comp);
          expect(status.a).toBe(1);
          expect(status.b).toBe(2);
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('symbol access on xr returns undefined', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect((comp.xr as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('symbol set on xr is rejected', () => {
      runInContext(
        () => {
          const comp = new Composition();
          const sym = Symbol('test');
          expect(() => {
            (comp.xr as unknown as Record<symbol, unknown>)[sym] = 1;
          }).toThrow(TypeError);
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('symbol set on xr.status is rejected', () => {
      runInContext(
        () => {
          const comp = new Composition();
          const sym = Symbol('test');
          expect(() => {
            (comp.xr.status as Record<symbol, unknown>)[sym] = 1;
          }).toThrow(TypeError);
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('writing to top-level xr field (non-status) updates observed', () => {
      const xr = { spec: { region: 'us-east-1' }, status: {} };
      runInContext(
        () => {
          const comp = new Composition();
          (comp.xr as Record<string, unknown>).customField = 'test';
          expect((comp.xr as Record<string, unknown>).customField).toBe('test');
        },
        { xr },
      );
    });

    it('has() on xr.status returns false for symbols', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect(Symbol.iterator in comp.xr.status).toBe(false);
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('xr.status has() checks observed when not in desired', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect('existingKey' in comp.xr.status).toBe(true);
        },
        { xr: { spec: {}, status: { existingKey: 'val' } } },
      );
    });

    it('xr.status has() returns false when no observed status', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect('missing' in comp.xr.status).toBe(false);
        },
        { xr: { spec: {} } },
      );
    });

    it('reading missing key from status with no observed returns undefined', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect(comp.xr.status.nonexistent).toBeUndefined();
        },
        { xr: { spec: {} } },
      );
    });

    it('reading missing key from status with observed but key absent returns undefined', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect(comp.xr.status.nope).toBeUndefined();
        },
        { xr: { spec: {}, status: { other: 'x' } } },
      );
    });

    it('symbol access on xr.status get returns undefined', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect((comp.xr.status as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('symbol in has() on outer xr proxy returns false', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect(Symbol.iterator in comp.xr).toBe(false);
        },
        { xr: { spec: {}, status: {} } },
      );
    });

    it('has() on outer xr proxy returns true for status and observed keys', () => {
      runInContext(
        () => {
          const comp = new Composition();
          expect('status' in comp.xr).toBe(true);
          expect('spec' in comp.xr).toBe(true);
        },
        { xr: { spec: {}, status: {} } },
      );
    });
  });
});
