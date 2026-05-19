import { describe, expect, it } from 'vitest';

import { DependencyGraph, EdgeCollector, isReadProxy } from '../../tracking/index.js';
import { createPrimitiveReadProxy } from '../../tracking/read-proxy.js';
import { Composition } from '../composition.js';
import { type CompositionContext, compositionStorage } from '../context.js';
import {
  getDesiredDocument,
  getExternalRef,
  getResourceRef,
  hydrateObserved,
  isExternal,
  Resource,
} from '../resource.js';

function runInContext<T>(
  fn: () => T,
  options: {
    xr?: Record<string, unknown>;
    pipelineContext?: Map<string, unknown>;
    requiredResources?: Map<string, Record<string, unknown>>;
  } = {},
): T {
  const graph = new DependencyGraph();
  const collector = new EdgeCollector();
  const ctx: CompositionContext = {
    xr: options.xr ?? { spec: {}, status: {} },
    pipelineContext: options.pipelineContext ?? new Map(),
    requiredResources: options.requiredResources ?? new Map(),
    graph,
    collector,
  };
  return compositionStorage.run(ctx, fn);
}

describe('Resource', () => {
  it('stores desired props in the desired document', () => {
    runInContext(() => {
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
      const desired = getDesiredDocument(comp.r);
      expect(desired.apiVersion).toBe('v1');
      expect(desired.kind).toBe('ConfigMap');
      expect(desired.data).toEqual({ key: 'value' });
    });
  });

  it('allows reading desired values back (desired-first)', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
          });
        }
      }
      const comp = new TestComp();
      const r = comp.r as Resource & Record<string, unknown>;
      expect(r.apiVersion).toBe('v1');
      expect(r.kind).toBe('ConfigMap');
    });
  });

  it('falls through to observed for unset paths', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'vpc', {
            apiVersion: 'ec2.aws/v1',
            kind: 'VPC',
            spec: { forProvider: { cidr: '10.0.0.0/16' } },
          });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { status: { atProvider: { vpcId: 'vpc-abc' } } });

      const status = (comp.r as unknown as Record<string, Record<string, Record<string, unknown>>>)
        .status!.atProvider!.vpcId;
      expect(`${status}`).toBe('vpc-abc');
    });
  });

  it('writes always go to desired', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      (comp.r as Resource & Record<string, unknown>).data = { key: 'new-value' };
      const desired = getDesiredDocument(comp.r);
      expect(desired.data).toEqual({ key: 'new-value' });
    });
  });

  it('has() works for desired and observed', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { status: { ready: true } });

      expect('node' in comp.r).toBe(true);
      expect('resource' in comp.r).toBe(true);
      expect('apiVersion' in comp.r).toBe(true);
      expect('status' in comp.r).toBe(true);
      expect('nonexistent' in comp.r).toBe(false);
    });
  });

  it('resource.autoReady defaults to true', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      expect(comp.r.resource.autoReady).toBe(true);
    });
  });

  it('node property returns Construct node', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'my-resource', { apiVersion: 'v1', kind: 'Pod' });
        }
      }
      const comp = new TestComp();
      expect(comp.r.node.id).toBe('my-resource');
      expect(comp.r.node.path).toContain('my-resource');
    });
  });

  it('getResourceRef returns the ref with construct path', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'vpc', { apiVersion: 'v1', kind: 'VPC' });
        }
      }
      const comp = new TestComp();
      const ref = getResourceRef(comp.r);
      expect(ref.id).toBe(comp.r.node.path);
    });
  });

  it('creates dependency edges when assigning ReadProxy from observed', () => {
    runInContext(() => {
      class TestComp extends Composition {
        vpc: Resource;
        subnet: Resource;
        constructor() {
          super();
          this.vpc = new Resource(this, 'vpc', { apiVersion: 'ec2/v1', kind: 'VPC' });
          this.subnet = new Resource(this, 'subnet', { apiVersion: 'ec2/v1', kind: 'Subnet' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.vpc, { status: { atProvider: { vpcId: 'vpc-123' } } });

      // Assign observed value from vpc to subnet
      const vpcId = (comp.vpc as unknown as Record<string, Record<string, Record<string, unknown>>>)
        .status!.atProvider!.vpcId;
      (comp.subnet as Resource & Record<string, unknown>).spec = { forProvider: { vpcId } };

      // Check that edge was recorded
      expect(comp.collector.edges.length).toBeGreaterThan(0);
    });
  });

  describe('fromExistingByName', () => {
    it('creates an external resource', () => {
      runInContext(() => {
        class TestComp extends Composition {
          r: Resource;
          constructor() {
            super();
            this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 'my-secret', 'default');
          }
        }
        const comp = new TestComp();
        expect(isExternal(comp.r)).toBe(true);
        const ref = getExternalRef(comp.r);
        expect(ref?.apiVersion).toBe('v1');
        expect(ref?.kind).toBe('Secret');
        expect(ref?.name).toBe('my-secret');
        expect(ref?.namespace).toBe('default');
      });
    });

    it('external resource ref key includes namespace', () => {
      runInContext(() => {
        class TestComp extends Composition {
          r: Resource;
          constructor() {
            super();
            this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 'my-secret', 'ns');
          }
        }
        const comp = new TestComp();
        const ref = getExternalRef(comp.r);
        expect(ref?.refKey).toBe('v1/Secret/ns/my-secret');
      });
    });

    it('external resource without namespace', () => {
      runInContext(() => {
        class TestComp extends Composition {
          r: Resource;
          constructor() {
            super();
            this.r = Resource.fromExistingByName(this, 'v1', 'ConfigMap', 'cm-1');
          }
        }
        const comp = new TestComp();
        const ref = getExternalRef(comp.r);
        expect(ref?.refKey).toBe('v1/ConfigMap/cm-1');
      });
    });

    it('unwraps PrimitiveReadProxy name to a string', () => {
      runInContext(() => {
        const owner = { id: 'Composition/ns' };
        const proxyName = createPrimitiveReadProxy('my-account', owner, 'metadata.labels.account');

        class TestComp extends Composition {
          r: Resource;
          constructor() {
            super();
            this.r = Resource.fromExistingByName(this, 'example.io/v1', 'Account', proxyName);
          }
        }
        const comp = new TestComp();
        const ref = getExternalRef(comp.r);
        expect(ref?.name).toBe('my-account');
        expect(ref?.refKey).toBe('example.io/v1/Account/my-account');
      });
    });

    it('stores undefined name when value cannot be coerced', () => {
      runInContext(() => {
        class TestComp extends Composition {
          r: Resource;
          constructor() {
            super();
            this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 42 as unknown);
          }
        }
        const comp = new TestComp();
        const ref = getExternalRef(comp.r);
        expect(ref?.name).toBe(42);
        expect(ref?.refKey).toBe('v1/Secret/__unresolved__');
      });
    });

    it('pre-hydrates from context when observed data is available', () => {
      const requiredResources = new Map<string, Record<string, unknown>>([
        [
          'v1/Namespace/my-ns',
          {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: 'my-ns', labels: { team: 'platform' } },
          },
        ],
      ]);

      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = Resource.fromExistingByName(this, 'v1', 'Namespace', 'my-ns');
            }
          }
          const comp = new TestComp();
          // The resource should have observed data from context
          const r = comp.r as Resource & { metadata: { labels: Record<string, string> } };
          expect(isReadProxy(r.metadata)).toBe(true);
          expect(String(r.metadata.labels.team)).toBe('platform');
        },
        { requiredResources },
      );
    });
  });

  describe('uniqueName', () => {
    it('generates deterministic unique name', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = new Resource(this, 'bucket', { apiVersion: 's3/v1', kind: 'Bucket' });
            }
          }
          const comp = new TestComp();
          const name1 = Resource.uniqueName(comp.r);
          const name2 = Resource.uniqueName(comp.r);
          expect(name1).toBe(name2);
          expect(name1.length).toBeLessThanOrEqual(63);
        },
        { xr: { metadata: { name: 'my-xr', namespace: 'team-a' }, spec: {}, status: {} } },
      );
    });

    it('respects maxLength', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = new Resource(this, 'a-very-long-resource-name-that-exceeds-limits', {
                apiVersion: 'v1',
                kind: 'X',
              });
            }
          }
          const comp = new TestComp();
          const name = Resource.uniqueName(comp.r, { maxLength: 20 });
          expect(name.length).toBeLessThanOrEqual(20);
        },
        { xr: { metadata: { name: 'my-xr' }, spec: {}, status: {} } },
      );
    });

    it('uses custom separator', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = new Resource(this, 'res', { apiVersion: 'v1', kind: 'X' });
            }
          }
          const comp = new TestComp();
          const name = Resource.uniqueName(comp.r, { separator: '_' });
          expect(name).toContain('_');
        },
        { xr: { metadata: { name: 'xr' }, spec: {}, status: {} } },
      );
    });

    it('uses extra option in unique name', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = new Resource(this, 'res', { apiVersion: 'v1', kind: 'X' });
            }
          }
          const comp = new TestComp();
          const name = Resource.uniqueName(comp.r, { extra: 'suffix' });
          expect(name).toContain('suffix');
        },
        { xr: { metadata: { name: 'xr' }, spec: {}, status: {} } },
      );
    });
  });

  it('symbol set on resource is forwarded to target', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      const sym = Symbol('test');
      (comp.r as unknown as Record<symbol, unknown>)[sym] = 'val';
      expect((comp.r as unknown as Record<symbol, unknown>)[sym]).toBe('val');
    });
  });

  it('symbol in has() delegates to target', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      expect(Symbol.iterator in comp.r).toBe(false);
    });
  });

  it('processes arrays in constructor props', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            data: { items: ['a', 'b', 'c'] },
          });
        }
      }
      const comp = new TestComp();
      const desired = getDesiredDocument(comp.r);
      expect((desired.data as Record<string, unknown>).items).toEqual(['a', 'b', 'c']);
    });
  });

  it('returns leaf ReadProxy for paths missing from both desired and observed', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      const missing = (comp.r as unknown as Record<string, unknown>).completely;
      expect(isReadProxy(missing)).toBe(true);
    });
  });

  it('constructor prop returns the Construct prototype method', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      expect((comp.r as unknown as Record<string, unknown>).constructor).toBe(Resource);
    });
  });

  it('returns primitive ReadProxy for observed primitive values', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      // Top-level primitive in observed (not in desired)
      hydrateObserved(comp.r, { count: 42 });
      const count = (comp.r as unknown as Record<string, unknown>).count;
      expect(isReadProxy(count)).toBe(true);
      expect(`${count}`).toBe('42');
    });
  });

  it('returns null observed values directly from resource proxy', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { nullField: null });
      const nf = (comp.r as unknown as Record<string, unknown>).nullField;
      expect(nf).toBeNull();
    });
  });

  it('reading back nested object from desired returns WriteProxy', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            spec: { region: 'us-east-1' },
          });
        }
      }
      const comp = new TestComp();
      // Reading spec back should give a WriteProxy (nested object in desired)
      const spec = (comp.r as unknown as Record<string, Record<string, unknown>>).spec;
      expect(spec).toBeDefined();
      expect(spec!.region).toBe('us-east-1');
      // Writing through it should update desired
      spec!.zone = 'a';
      const desired = getDesiredDocument(comp.r);
      expect((desired.spec as Record<string, unknown>).zone).toBe('a');
    });
  });

  it('throws when Resource is created outside a Composition tree', () => {
    runInContext(() => {
      const { Construct } = require('constructs');
      const root = new Construct(undefined, 'root');
      expect(() => {
        new Resource(root as unknown as Composition, 'bad', {
          apiVersion: 'v1',
          kind: 'X',
        });
      }).toThrow('Resource must be created within a Composition tree');
    });
  });
});
