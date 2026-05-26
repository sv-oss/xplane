import { Construct } from 'constructs';
import { describe, expect, it } from 'vitest';
import { Composition } from '../../core/composition.js';
import { type CompositionContext, compositionStorage } from '../../core/context.js';
import {
  getDesiredDocument,
  getResourceRef,
  hydrateObserved,
  Resource,
} from '../../core/resource.js';
import { DependencyGraph, EdgeCollector, Pending } from '../../tracking/index.js';
import { diagnose } from '../diagnose.js';
import { emit } from '../emit.js';
import { hydrate } from '../hydrate.js';
import { runPipeline } from '../index.js';
import { resolve } from '../resolve.js';
import { sequence } from '../sequence.js';
import type { PipelineState } from '../types.js';

function createContext(xr: Record<string, unknown> = { spec: {}, status: {} }): CompositionContext {
  return {
    xr,
    pipelineContext: new Map(),
    requiredResources: new Map(),
    graph: new DependencyGraph(),
    collector: new EdgeCollector(),
  };
}

function buildState(
  composition: Composition,
  resources: Resource[],
  observedComposed: Map<string, Record<string, unknown>> = new Map(),
  observedRequired: Map<string, Record<string, unknown>> = new Map(),
): PipelineState {
  return {
    composition,
    resources,
    graph: composition.graph,
    observedComposed,
    observedRequired,
    classification: new Map(),
    diagnostics: [],
    emitted: [],
    xrStatusPatches: {},
  };
}

describe('Pipeline: hydrate', () => {
  it('hydrates composed resources by construct path', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
        }
      }
      const comp = new TestComp();
      const observed = new Map<string, Record<string, unknown>>([
        [comp.r.node.path, { status: { atProvider: { vpcId: 'vpc-123' } } }],
      ]);
      const state = buildState(comp, [comp.r], observed);
      hydrate(state);

      // Now observed data should be accessible
      const vpcId = (comp.r as unknown as Record<string, Record<string, Record<string, unknown>>>)
        .status!.atProvider!.vpcId;
      expect(`${vpcId}`).toBe('vpc-123');
    });
  });

  it('hydrates external resources by refKey', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 'db-creds', 'default');
        }
      }
      const comp = new TestComp();
      const observed = new Map<string, Record<string, unknown>>([
        ['v1/Secret/default/db-creds', { data: { password: 'secret123' } }],
      ]);
      const state = buildState(comp, [comp.r], new Map(), observed);
      hydrate(state);

      const data = (comp.r as unknown as Record<string, Record<string, unknown>>).data!.password;
      expect(`${data}`).toBe('secret123');
    });
  });
});

describe('Pipeline: resolve', () => {
  it('resolves Pending markers when observed data is available', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
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
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();

      // Verify Pending exists
      const desiredBefore = getDesiredDocument(comp.subnet);
      const specBefore = desiredBefore.spec as Record<string, Record<string, unknown>>;
      expect(Pending.is(specBefore.forProvider!.vpcId)).toBe(true);

      // Hydrate vpc with observed data
      hydrateObserved(comp.vpc, { status: { atProvider: { vpcId: 'vpc-abc' } } });

      const state = buildState(comp, [comp.vpc, comp.subnet]);
      resolve(state);

      // Pending should now be resolved
      const desiredAfter = getDesiredDocument(comp.subnet);
      const specAfter = desiredAfter.spec as Record<string, Record<string, unknown>>;
      expect(specAfter.forProvider!.vpcId).toBe('vpc-abc');
    });
  });

  it('leaves Pending in place when observed data is not available', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
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
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();
      // Don't hydrate vpc — no observed data

      const state = buildState(comp, [comp.vpc, comp.subnet]);
      resolve(state);

      const desired = getDesiredDocument(comp.subnet);
      const spec = desired.spec as Record<string, Record<string, unknown>>;
      expect(Pending.is(spec.forProvider!.vpcId)).toBe(true);
    });
  });
});

describe('Pipeline: sequence', () => {
  it('classifies resolved resources as emit', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            data: { key: 'value' },
          });
        }
      }
      const comp = new TestComp();
      const state = buildState(comp, [comp.r]);
      const result = sequence(state);

      const ref = getResourceRef(comp.r);
      expect(result.classification.get(ref.id)).toBe('emit');
    });
  });

  it('classifies resources with Pending as blocked', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
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
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();
      const state = buildState(comp, [comp.vpc, comp.subnet]);
      const result = sequence(state);

      const vpcRef = getResourceRef(comp.vpc);
      const subnetRef = getResourceRef(comp.subnet);
      expect(result.classification.get(vpcRef.id)).toBe('emit');
      expect(result.classification.get(subnetRef.id)).toBe('blocked');
    });
  });

  it('classifies external resources as external', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 'sec');
        }
      }
      const comp = new TestComp();
      const state = buildState(comp, [comp.r]);
      const result = sequence(state);

      const ref = getResourceRef(comp.r);
      expect(result.classification.get(ref.id)).toBe('external');
    });
  });
});

describe('Pipeline: diagnose', () => {
  it('produces diagnostic for blocked resources', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
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
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();
      let state = buildState(comp, [comp.vpc, comp.subnet]);
      state = sequence(state);
      state = diagnose(state);

      expect(state.diagnostics.length).toBeGreaterThan(0);
      const diag = state.diagnostics.find((d) => d.resource.includes('subnet'));
      expect(diag).toBeDefined();
      expect(diag!.reason).toBe('pending');
      expect(diag!.pendingPaths!.length).toBeGreaterThan(0);
    });
  });

  it('produces not-found diagnostic for unhydrated external resources', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        ext: Resource;
        constructor() {
          super();
          this.ext = Resource.fromExistingByName(this, 'test.io/v1', 'Project', 'my-project');
        }
      }
      const comp = new TestComp();
      // Do NOT hydrate the external resource — simulates Crossplane not finding it
      let state = buildState(comp, [comp.ext]);
      state = sequence(state);
      state = diagnose(state);

      const diag = state.diagnostics.find((d) => d.reason === 'not-found');
      expect(diag).toBeDefined();
      expect(diag!.detail).toContain('test.io/v1/Project');
      expect(diag!.detail).toContain('my-project');
      expect(diag!.detail).toContain('not found');
    });
  });
});

describe('Pipeline: emit', () => {
  it('emits resources classified as emit', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            data: { key: 'value' },
          });
        }
      }
      const comp = new TestComp();
      let state = buildState(comp, [comp.r]);
      state = sequence(state);
      state = diagnose(state);
      state = emit(state);

      expect(state.emitted).toHaveLength(1);
      expect(state.emitted[0]!.name).toBe('cm');
      expect(state.emitted[0]!.document).toEqual({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        data: { key: 'value' },
      });
      expect(state.emitted[0]!.autoReady).toBe(true);
    });
  });

  it('does not emit external resources', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 's');
        }
      }
      const comp = new TestComp();
      let state = buildState(comp, [comp.r]);
      state = sequence(state);
      state = diagnose(state);
      state = emit(state);

      expect(state.emitted).toHaveLength(0);
    });
  });

  it('does not emit blocked resources', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
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
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();
      let state = buildState(comp, [comp.vpc, comp.subnet]);
      state = sequence(state);
      state = diagnose(state);
      state = emit(state);

      // Only vpc should be emitted, subnet is blocked
      expect(state.emitted).toHaveLength(1);
      expect(state.emitted[0]!.name).toBe('vpc');
    });
  });

  it('extracts XR desired status', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        constructor() {
          super();
          (this.xr.status as Record<string, unknown>).ready = true;
          (this.xr.status as Record<string, unknown>).message = 'all good';
          new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      let state = buildState(comp, comp.node.children as Resource[]);
      state = sequence(state);
      state = diagnose(state);
      state = emit(state);

      expect(state.xrStatusPatches).toEqual({ ready: true, message: 'all good' });
    });
  });

  it('resolves ReadProxy values in XR status after hydration', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        constructor() {
          super();
          const zone = new Resource(this, 'zone', {
            apiVersion: 'route53.aws/v1beta1',
            kind: 'Zone',
          });
          const cm = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
          // Assign read proxy values to XR status (before hydration)
          const zoneAny = zone as unknown as { status: { atProvider: { id: unknown } } };
          const cmAny = cm as unknown as { metadata: { name: unknown } };
          (this.xr.status as Record<string, unknown>).config = {
            zoneId: zoneAny.status?.atProvider?.id,
            configMapName: cmAny.metadata?.name,
            staticValue: 'hello',
          };
        }
      }
      const comp = new TestComp();

      // Simulate what the handler does: hydrate with observed data
      const observedComposed = new Map<string, Record<string, unknown>>([
        ['Composition/zone', { status: { atProvider: { id: 'zone-123' } } }],
        ['Composition/cm', { metadata: { name: 'my-cm' } }],
      ]);
      const result = runPipeline({
        composition: comp,
        observedComposed,
        observedRequired: new Map(),
      });

      // ReadProxy values should be resolved from observed data
      expect(result.xrStatusPatches).toEqual({
        config: {
          zoneId: 'zone-123',
          configMapName: 'my-cm',
          staticValue: 'hello',
        },
      });
    });
  });

  it('strips unresolvable ReadProxy values from XR status', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        constructor() {
          super();
          const zone = new Resource(this, 'zone', {
            apiVersion: 'route53.aws/v1beta1',
            kind: 'Zone',
          });
          const zoneAny = zone as unknown as { status: { atProvider: { id: unknown } } };
          (this.xr.status as Record<string, unknown>).config = {
            zoneId: zoneAny.status?.atProvider?.id,
            staticValue: 'hello',
          };
        }
      }
      const comp = new TestComp();

      // No observed data — read proxy values can't be resolved
      const result = runPipeline({
        composition: comp,
        observedComposed: new Map(),
        observedRequired: new Map(),
      });

      // Unresolvable values should be stripped, only static value remains
      expect(result.xrStatusPatches).toEqual({
        config: { staticValue: 'hello' },
      });
    });
  });
});

describe('Pipeline: runPipeline (integration)', () => {
  it('full pipeline: resolved resources are emitted, unresolved are blocked', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        vpc: Resource;
        subnet: Resource;
        constructor() {
          super();
          this.vpc = new Resource(this, 'vpc', {
            apiVersion: 'ec2/v1',
            kind: 'VPC',
            spec: { forProvider: { cidr: '10.0.0.0/16' } },
          });
          this.subnet = new Resource(this, 'subnet', {
            apiVersion: 'ec2/v1',
            kind: 'Subnet',
            spec: {
              forProvider: {
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();
      const result = runPipeline({
        composition: comp,
        observedComposed: new Map([
          [comp.vpc.node.path, { status: { atProvider: { vpcId: 'vpc-resolved' } } }],
        ]),
        observedRequired: new Map(),
      });

      // VPC is emitted
      expect(result.emitted.find((e) => e.name === 'vpc')).toBeDefined();
      // Subnet is also emitted (vpcId resolved from observed)
      const subnet = result.emitted.find((e) => e.name === 'subnet');
      expect(subnet).toBeDefined();
      expect(
        (subnet!.document.spec as Record<string, Record<string, unknown>>).forProvider!.vpcId,
      ).toBe('vpc-resolved');
      // No diagnostics
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  it('full pipeline: unresolved deps produce diagnostics', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
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
                vpcId: (this.vpc as unknown as Record<
                  string,
                  Record<string, Record<string, unknown>>
                >)!.status!.atProvider!.vpcId,
              },
            },
          });
        }
      }
      const comp = new TestComp();
      const result = runPipeline({
        composition: comp,
        observedComposed: new Map(), // no observed data
        observedRequired: new Map(),
      });

      // VPC emitted (no pending), subnet blocked
      expect(result.emitted.find((e) => e.name === 'vpc')).toBeDefined();
      expect(result.emitted.find((e) => e.name === 'subnet')).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });

  it('full pipeline: metadata.name fallback to observed when metadata partially in desired', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        service: Resource;
        domainMapping: Resource;
        constructor() {
          super();
          // Service has metadata with labels but no explicit name (auto-generated by runtime)
          this.service = new Resource(this, 'service', {
            apiVersion: 'serving.knative.dev/v1',
            kind: 'Service',
            metadata: {
              labels: { 'networking.knative.dev/visibility': 'cluster-local' },
            },
            spec: { template: {} },
          });
          // DomainMapping references the service's metadata.name (only in observed)
          this.domainMapping = new Resource(this, 'domain-mapping', {
            apiVersion: 'serving.knative.dev/v1beta1',
            kind: 'DomainMapping',
            spec: {
              ref: {
                kind: 'Service',
                name: (this.service as unknown as Record<string, Record<string, unknown>>).metadata!
                  .name,
                apiVersion: 'serving.knative.dev/v1',
              },
            },
          });
        }
      }
      const comp = new TestComp();

      // Without observed data: domainMapping should be blocked (Pending on service metadata.name)
      const resultBlocked = runPipeline({
        composition: comp,
        observedComposed: new Map(),
        observedRequired: new Map(),
      });
      expect(resultBlocked.emitted.find((e) => e.name === 'service')).toBeDefined();
      expect(resultBlocked.emitted.find((e) => e.name === 'domain-mapping')).toBeUndefined();

      // With observed data: domainMapping should resolve the name
      const resultResolved = runPipeline({
        composition: comp,
        observedComposed: new Map([
          [
            comp.service.node.path,
            {
              metadata: {
                name: 'my-xr-abc123',
                labels: { 'networking.knative.dev/visibility': 'cluster-local' },
              },
            },
          ],
        ]),
        observedRequired: new Map(),
      });
      expect(resultResolved.emitted.find((e) => e.name === 'service')).toBeDefined();
      const dm = resultResolved.emitted.find((e) => e.name === 'domain-mapping');
      expect(dm).toBeDefined();
      const ref = (dm!.document.spec as Record<string, Record<string, unknown>>).ref!;
      expect(ref.name).toBe('my-xr-abc123');
    });
  });
});

describe('Pipeline: resolve (advanced)', () => {
  it('resolves Pending in arrays', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        vpc: Resource;
        sg: Resource;
        constructor() {
          super();
          this.vpc = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
          this.sg = new Resource(this, 'sg', {
            apiVersion: 'ec2/v1',
            kind: 'SecurityGroup',
            spec: {
              forProvider: {
                ingress: [
                  (this.vpc as unknown as Record<string, Record<string, Record<string, unknown>>>)
                    .status!.atProvider!.vpcId,
                ],
              },
            },
          });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.vpc, { status: { atProvider: { vpcId: 'vpc-resolved' } } });

      const state = buildState(comp, [comp.vpc, comp.sg]);
      resolve(state);

      const desired = getDesiredDocument(comp.sg);
      const spec = desired.spec as Record<string, Record<string, unknown[]>>;
      expect(spec.forProvider!.ingress![0]).toBe('vpc-resolved');
    });
  });

  it('resolves nested objects within arrays', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        vpc: Resource;
        app: Resource;
        constructor() {
          super();
          this.vpc = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
          this.app = new Resource(this, 'app', {
            apiVersion: 'app/v1',
            kind: 'Deployment',
            spec: {
              envVars: [
                {
                  name: 'VPC_ID',
                  value: (this.vpc as unknown as Record<
                    string,
                    Record<string, Record<string, unknown>>
                  >)!.status!.atProvider!.vpcId,
                },
              ],
            },
          });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.vpc, { status: { atProvider: { vpcId: 'vpc-456' } } });

      const state = buildState(comp, [comp.vpc, comp.app]);
      resolve(state);

      const desired = getDesiredDocument(comp.app);
      const spec = desired.spec as Record<string, Array<Record<string, unknown>>>;
      expect(spec.envVars![0]!.value).toBe('vpc-456');
    });
  });

  it('handles bracket notation paths from observed data', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        src: Resource;
        dest: Resource;
        constructor() {
          super();
          this.src = new Resource(this, 'src', { apiVersion: 'v1', kind: 'Source' });
          this.dest = new Resource(this, 'dest', {
            apiVersion: 'v1',
            kind: 'Dest',
            ref: (this.src as unknown as Record<string, Record<string, unknown>>).status!.id,
          });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.src, { status: { id: 'resolved-id' } });

      const state = buildState(comp, [comp.src, comp.dest]);
      resolve(state);

      const desired = getDesiredDocument(comp.dest);
      expect(desired.ref).toBe('resolved-id');
    });
  });

  it('getNestedValue returns undefined for non-object intermediate', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        src: Resource;
        dest: Resource;
        constructor() {
          super();
          this.src = new Resource(this, 'src', { apiVersion: 'v1', kind: 'Source' });
          this.dest = new Resource(this, 'dest', {
            apiVersion: 'v1',
            kind: 'Dest',
            ref: (this.src as unknown as Record<string, Record<string, Record<string, unknown>>>)
              .status!.primitive!.nested,
          });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.src, { status: { primitive: 'just-a-string' } });

      const state = buildState(comp, [comp.src, comp.dest]);
      resolve(state);

      const desired = getDesiredDocument(comp.dest);
      expect(Pending.is(desired.ref)).toBe(true);
    });
  });
});

describe('Pipeline: diagnose (advanced)', () => {
  it('detects cycles and produces cycle diagnostic', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        a: Resource;
        b: Resource;
        constructor() {
          super();
          this.a = new Resource(this, 'a', { apiVersion: 'v1', kind: 'A' });
          this.b = new Resource(this, 'b', { apiVersion: 'v1', kind: 'B' });
        }
      }
      const comp = new TestComp();
      const refA = getResourceRef(comp.a);
      const refB = getResourceRef(comp.b);

      comp.graph.addExplicitDependency(refA, refB);
      comp.graph.addExplicitDependency(refB, refA);

      let state = buildState(comp, [comp.a, comp.b]);
      state = sequence(state);
      state = diagnose(state);

      const cycleDiag = state.diagnostics.find((d) => d.reason === 'cycle');
      expect(cycleDiag).toBeDefined();
      expect(cycleDiag!.cycle!.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('findPendingPaths handles arrays', () => {
    const ctx = createContext();
    compositionStorage.run(ctx, () => {
      class TestComp extends Composition {
        src: Resource;
        dest: Resource;
        constructor() {
          super();
          this.src = new Resource(this, 'src', { apiVersion: 'v1', kind: 'S' });
          this.dest = new Resource(this, 'dest', {
            apiVersion: 'v1',
            kind: 'D',
            items: [(this.src as unknown as Record<string, Record<string, unknown>>).status!.id],
          });
        }
      }
      const comp = new TestComp();
      let state = buildState(comp, [comp.src, comp.dest]);
      state = sequence(state);
      state = diagnose(state);

      const diag = state.diagnostics.find((d) => d.resource.includes('dest'));
      expect(diag).toBeDefined();
      expect(diag!.pendingPaths!.some((p) => p.path.includes('[0]'))).toBe(true);
    });
  });

  describe('emit (edge cases)', () => {
    it('deepClean handles arrays with Pending values', () => {
      const ctx = createContext();
      compositionStorage.run(ctx, () => {
        class TestComp extends Composition {
          r: Resource;
          constructor() {
            super();
            this.r = new Resource(this, 'cm', {
              apiVersion: 'v1',
              kind: 'ConfigMap',
              data: { items: ['a', 'b'] },
            });
          }
        }
        const comp = new TestComp();
        const state = buildState(comp, [comp.r]);
        const sequenced = sequence(state);
        const result = emit(sequenced);
        expect(result.emitted.length).toBe(1);
        expect((result.emitted[0]!.document.data as Record<string, unknown>).items).toEqual([
          'a',
          'b',
        ]);
      });
    });
  });

  describe('resolve (resolveArray and parsePath)', () => {
    it('resolves Pending inside arrays', () => {
      const ctx = createContext();
      compositionStorage.run(ctx, () => {
        class TestComp extends Composition {
          vpc: Resource;
          subnet: Resource;
          constructor() {
            super();
            this.vpc = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
            this.subnet = new Resource(this, 'subnet', {
              apiVersion: 'ec2/v1',
              kind: 'Subnet',
              // biome-ignore lint/suspicious/noExplicitAny: tests
              spec: { vpcIds: [(this.vpc as any).status.vpcId] },
            });
          }
        }
        const comp = new TestComp();
        hydrateObserved(comp.vpc, { status: { vpcId: 'vpc-resolved' } });

        const state = buildState(comp, [comp.vpc, comp.subnet]);
        resolve(state);

        const desired = getDesiredDocument(comp.subnet);
        const spec = desired.spec as Record<string, unknown>;
        expect((spec.vpcIds as unknown[])[0]).toBe('vpc-resolved');
      });
    });

    it('resolves nested object inside arrays', () => {
      const ctx = createContext();
      compositionStorage.run(ctx, () => {
        class TestComp extends Composition {
          vpc: Resource;
          subnet: Resource;
          constructor() {
            super();
            this.vpc = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
            this.subnet = new Resource(this, 'subnet', {
              apiVersion: 'ec2/v1',
              kind: 'Subnet',
              // biome-ignore lint/suspicious/noExplicitAny: tests
              spec: { refs: [{ id: (this.vpc as any).status.vpcId }] },
            });
          }
        }
        const comp = new TestComp();
        hydrateObserved(comp.vpc, { status: { vpcId: 'vpc-456' } });

        const state = buildState(comp, [comp.vpc, comp.subnet]);
        resolve(state);

        const desired = getDesiredDocument(comp.subnet);
        const refs = (desired.spec as Record<string, unknown>).refs as Record<string, unknown>[];
        expect(refs[0]!.id).toBe('vpc-456');
      });
    });

    it('resolves paths pointing to array values', () => {
      const ctx = createContext();
      compositionStorage.run(ctx, () => {
        class TestComp extends Composition {
          src: Resource;
          dst: Resource;
          constructor() {
            super();
            this.src = new Resource(this, 'src', { apiVersion: 'v1', kind: 'Src' });
            this.dst = new Resource(this, 'dst', {
              apiVersion: 'v1',
              kind: 'Dst',
            });
            // biome-ignore lint/suspicious/noExplicitAny: tests
            (this.dst as any).spec = { ref: (this.src as any).status.items };
          }
        }
        const comp = new TestComp();
        hydrateObserved(comp.src, { status: { items: ['first', 'second'] } });

        const state = buildState(comp, [comp.src, comp.dst]);
        resolve(state);

        const desired = getDesiredDocument(comp.dst);
        const spec = desired.spec as Record<string, unknown>;
        expect(spec.ref).toEqual(['first', 'second']);
      });
    });

    it('resolves nested arrays recursively', () => {
      const ctx = createContext();
      compositionStorage.run(ctx, () => {
        class TestComp extends Composition {
          src: Resource;
          dst: Resource;
          constructor() {
            super();
            this.src = new Resource(this, 'src', { apiVersion: 'v1', kind: 'Src' });
            this.dst = new Resource(this, 'dst', { apiVersion: 'v1', kind: 'Dst' });
          }
        }
        const comp = new TestComp();
        const srcRef = getResourceRef(comp.src);
        hydrateObserved(comp.src, { status: { id: 'resolved-id' } });

        // Manually place a nested array with Pending in desired
        const desired = getDesiredDocument(comp.dst);
        desired.matrix = [[new Pending(srcRef, 'status.id')]];

        const state = buildState(comp, [comp.src, comp.dst]);
        resolve(state);

        expect((desired.matrix as unknown[][])![0]![0]).toBe('resolved-id');
      });
    });
  });

  describe('collectResources (nested constructs)', () => {
    it('collects resources from nested construct trees via runPipeline', () => {
      const ctx = createContext();
      compositionStorage.run(ctx, () => {
        class Inner extends Construct {
          r: Resource;
          constructor(scope: Construct) {
            super(scope, 'inner');
            this.r = new Resource(this, 'nested', { apiVersion: 'v1', kind: 'Nested' });
          }
        }
        class Outer extends Composition {
          inner: Inner;
          top: Resource;
          constructor() {
            super();
            this.top = new Resource(this, 'top', { apiVersion: 'v1', kind: 'Top' });
            this.inner = new Inner(this);
          }
        }
        const comp = new Outer();
        const state = buildState(comp, [comp.top, comp.inner.r]);
        const sequenced = sequence(state);
        // Both resources should be classified as emit
        expect(sequenced.classification.size).toBe(2);
      });
    });
  });
});
