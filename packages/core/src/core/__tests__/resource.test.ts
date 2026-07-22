import { describe, expect, it } from 'vitest';

import { DependencyGraph, EdgeCollector, isReadProxy, Pending } from '../../tracking/index.js';
import { createPrimitiveReadProxy } from '../../tracking/read-proxy.js';
import { createTokenRegistry, tokenRegistryStorage } from '../../tracking/token-registry.js';
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
    observedComposed: new Map(),
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

    it('unwraps PrimitiveReadProxy name even when an active token registry is in scope', () => {
      // Regression: under a real composition run a token registry is active,
      // so `Symbol.toPrimitive`/`String(proxy)` returns a `__pending__tpl_*__`
      // token. `fromExistingByName` must extract the raw value via `valueOf`
      // — otherwise the external-resource refKey is corrupted with tokens
      // and the lookup never finds the underlying object.
      runInContext(() => {
        tokenRegistryStorage.run(createTokenRegistry(), () => {
          const owner = { id: 'Composition/ns' };
          const proxyName = createPrimitiveReadProxy('db-creds', owner, 'metadata.name');
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = Resource.fromExistingByName(this, 'v1', 'Secret', proxyName, 'default');
            }
          }
          const comp = new TestComp();
          const ref = getExternalRef(comp.r);
          expect(ref?.name).toBe('db-creds');
          expect(ref?.refKey).toBe('v1/Secret/default/db-creds');
        });
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

    it('is read-only: writes fail loudly', () => {
      const requiredResources = new Map<string, Record<string, unknown>>([
        [
          'v1/Secret/default/db-creds',
          { apiVersion: 'v1', kind: 'Secret', data: { password: 'p' }, spec: { a: { b: 1 } } },
        ],
      ]);

      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = Resource.fromExistingByName(this, 'v1', 'Secret', 'db-creds', 'default');
            }
          }
          const comp = new TestComp();
          const r = comp.r as Resource & Record<string, unknown>;

          // Top-level write throws.
          expect(() => {
            (r as Record<string, unknown>).stringData = { x: 'y' };
          }).toThrow(/read-only/);

          // Nested write (through the observed subtree) throws too.
          expect(() => {
            (r as unknown as { spec: { a: { c: number } } }).spec.a.c = 2;
          }).toThrow(/read-only/);

          // setDesired throws.
          expect(() => comp.r.setDesired('metadata.labels.team', 'x')).toThrow(/read-only/);

          // Reads still work.
          expect(comp.r.getObserved('data.password')).toBe('p');
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

  describe('uniqueNameRfc1123', () => {
    const RFC1123_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

    it('generates a valid RFC 1123 name', () => {
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
          const name = Resource.uniqueNameRfc1123(comp.r);
          expect(RFC1123_RE.test(name)).toBe(true);
          expect(name.length).toBeLessThanOrEqual(63);
        },
        { xr: { metadata: { name: 'my-xr', namespace: 'team-a' }, spec: {}, status: {} } },
      );
    });

    it('lowercases uppercase characters', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = new Resource(this, 'MyResource', { apiVersion: 'v1', kind: 'X' });
            }
          }
          const comp = new TestComp();
          const name = Resource.uniqueNameRfc1123(comp.r);
          expect(name).toBe(name.toLowerCase());
          expect(RFC1123_RE.test(name)).toBe(true);
        },
        { xr: { metadata: { name: 'MyXR', namespace: 'TeamA' }, spec: {}, status: {} } },
      );
    });

    it('is deterministic', () => {
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
          expect(Resource.uniqueNameRfc1123(comp.r)).toBe(Resource.uniqueNameRfc1123(comp.r));
        },
        { xr: { metadata: { name: 'xr' }, spec: {}, status: {} } },
      );
    });

    it('respects maxLength', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              this.r = new Resource(this, 'a-very-long-resource-name-exceeds-limits', {
                apiVersion: 'v1',
                kind: 'X',
              });
            }
          }
          const comp = new TestComp();
          const name = Resource.uniqueNameRfc1123(comp.r, { maxLength: 20 });
          expect(name.length).toBeLessThanOrEqual(20);
          expect(RFC1123_RE.test(name)).toBe(true);
        },
        { xr: { metadata: { name: 'my-xr', namespace: 'team' }, spec: {}, status: {} } },
      );
    });

    it('uses extra option', () => {
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
          const name = Resource.uniqueNameRfc1123(comp.r, { extra: 'rw' });
          expect(name).toContain('rw');
          expect(RFC1123_RE.test(name)).toBe(true);
        },
        { xr: { metadata: { name: 'xr' }, spec: {}, status: {} } },
      );
    });

    it('replaces non-RFC-1123 characters with hyphens', () => {
      runInContext(
        () => {
          class TestComp extends Composition {
            r: Resource;
            constructor() {
              super();
              // underscores and dots are not valid DNS label chars
              this.r = new Resource(this, 'res_with.special', { apiVersion: 'v1', kind: 'X' });
            }
          }
          const comp = new TestComp();
          const name = Resource.uniqueNameRfc1123(comp.r);
          expect(RFC1123_RE.test(name)).toBe(true);
          expect(name).not.toContain('_');
          expect(name).not.toContain('.');
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

  it('allows nested writes on paths not in desired or observed (auto-init)', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      // metadata was not passed in props — nested write should work
      comp.r.metadata.namespace = 'my-ns';
      const doc = getDesiredDocument(comp.r);
      expect((doc.metadata as Record<string, unknown>).namespace).toBe('my-ns');
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

  it('node.children yields the proxy (supports lazy-init writes)', () => {
    runInContext(() => {
      class TestComp extends Composition {
        constructor() {
          super();
          new Resource(this, 'sg', { apiVersion: 'ec2/v1', kind: 'SecurityGroup' });
        }
      }
      const comp = new TestComp();
      const child = comp.node.children[0] as Resource;

      // The child from the tree should support proxy behavior
      child.metadata.namespace = 'test-ns';
      const doc = getDesiredDocument(child);
      expect((doc.metadata as Record<string, unknown>).namespace).toBe('test-ns');
    });
  });

  it('node.findAll yields proxies that support writes', () => {
    runInContext(() => {
      class TestComp extends Composition {
        constructor() {
          super();
          new Resource(this, 'r1', { apiVersion: 'v1', kind: 'ConfigMap' });
          new Resource(this, 'r2', { apiVersion: 'v1', kind: 'Secret' });
        }
      }
      const comp = new TestComp();
      const all = comp.node.findAll();
      // findAll includes the composition itself + children
      const resources = all.filter((c) => c !== comp) as Resource[];
      for (const r of resources) {
        r.metadata.namespace = 'ns';
      }
      for (const r of resources) {
        const doc = getDesiredDocument(r);
        expect((doc.metadata as Record<string, unknown>).namespace).toBe('ns');
      }
    });
  });

  it('exposes Construct prototype methods like .with()', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      // .with() should be a function (from Construct prototype)
      expect(typeof (comp.r as unknown as { with: unknown }).with).toBe('function');
    });
  });
});

type AnyResource = Resource & {
  // biome-ignore lint/suspicious/noExplicitAny: deep proxy chaining in tests
  [key: string]: any;
};

describe('Resource.getObserved / getDesired / setDesired', () => {
  it('reads nested observed values via a dot path', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { status: { atProvider: { id: 'obs-123' } } });
      expect(comp.r.getObserved('status.atProvider.id')).toBe('obs-123');
    });
  });

  it('reads observed values via array segments (keys containing dots)', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'svc', { apiVersion: 'serving/v1', kind: 'Service' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, {
        metadata: { annotations: { 'serving.knative.dev/creator': 'alice' } },
      });
      expect(comp.r.getObserved(['metadata', 'annotations', 'serving.knative.dev/creator'])).toBe(
        'alice',
      );
    });
  });

  it('returns the default value when an observed path is missing', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { metadata: { name: 'x' } });
      expect(comp.r.getObserved('metadata.missing.deep', 'fallback')).toBe('fallback');
      expect(comp.r.getObserved('metadata.missing.deep')).toBeUndefined();
    });
  });

  it('getObserved does not fall back to desired state', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { annotations: { 'app.io/owner': 'desired-team' } },
          });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, {
        metadata: { annotations: { 'app.io/creator': 'observed-user' } },
      });
      // Desired has annotations, but getObserved still sees the observed keys.
      expect(comp.r.getObserved(['metadata', 'annotations', 'app.io/creator'])).toBe(
        'observed-user',
      );
      expect(comp.r.getObserved(['metadata', 'annotations', 'app.io/owner'])).toBeUndefined();
    });
  });

  it('reads desired values and returns the default when missing', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            spec: { replicas: 3 },
          });
        }
      }
      const comp = new TestComp();
      expect(comp.r.getDesired('spec.replicas')).toBe(3);
      expect(comp.r.getDesired('spec.missing', 'def')).toBe('def');
    });
  });

  it('setDesired deep-creates intermediate objects', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      comp.r.setDesired('spec.forProvider.tags.env', 'prod');
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ forProvider: { tags: { env: 'prod' } } });
    });
  });

  it('setDesired supports array segments for dotted keys', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'svc', { apiVersion: 'serving/v1', kind: 'Service' });
        }
      }
      const comp = new TestComp();
      comp.r.setDesired(['metadata', 'annotations', 'serving.knative.dev/creator'], 'bob');
      expect(comp.r.getDesired(['metadata', 'annotations', 'serving.knative.dev/creator'])).toBe(
        'bob',
      );
    });
  });

  it('handles a dotted key as an intermediate (non-leaf) segment', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { spec: { 'config.io/settings': { timeout: 30 } } });

      // Read past a dotted key that is not the final segment.
      expect(comp.r.getObserved(['spec', 'config.io/settings', 'timeout'])).toBe(30);

      // Write past a dotted intermediate key, auto-creating both levels.
      comp.r.setDesired(['spec', 'config.io/settings', 'retries'], 5);
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ 'config.io/settings': { retries: 5 } });
      expect(comp.r.getDesired(['spec', 'config.io/settings', 'retries'])).toBe(5);
    });
  });

  it('setDesired with { overwrite: false } does not replace an existing value', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            spec: { replicas: 3 },
          });
        }
      }
      const comp = new TestComp();
      comp.r.setDesired('spec.replicas', 9, { overwrite: false });
      expect(comp.r.getDesired('spec.replicas')).toBe(3);
      comp.r.setDesired('spec.replicas', 9);
      expect(comp.r.getDesired('spec.replicas')).toBe(9);
      // overwrite:false still writes when the path is unset
      comp.r.setDesired('spec.image', 'nginx', { overwrite: false });
      expect(comp.r.getDesired('spec.image')).toBe('nginx');
    });
  });

  it('setDesired records a cross-resource reference as a Pending marker', () => {
    runInContext(() => {
      class TestComp extends Composition {
        a: Resource;
        b: Resource;
        constructor() {
          super();
          this.a = new Resource(this, 'a', { apiVersion: 'v1', kind: 'VPC' });
          this.b = new Resource(this, 'b', { apiVersion: 'v1', kind: 'Subnet' });
        }
      }
      const comp = new TestComp();
      const vpcId = (comp.a as AnyResource).status!.atProvider!.vpcId;
      comp.b.setDesired('spec.vpcId', vpcId);
      expect(Pending.is(comp.b.getDesired('spec.vpcId'))).toBe(true);
    });
  });

  it('throws on an empty path', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      expect(() => comp.r.getObserved('')).toThrow('Invalid path');
      expect(() => comp.r.setDesired([], 1)).toThrow('Invalid path');
    });
  });

  it('preserves observed immutable annotations even after desired writes (bug repro)', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'svc', { apiVersion: 'serving/v1', kind: 'Service' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, {
        metadata: {
          annotations: {
            'serving.knative.dev/creator': 'system:admin',
            'serving.knative.dev/lastModifier': 'system:admin',
          },
        },
      });

      // The composition writes its own annotation.
      comp.r.setDesired(['metadata', 'annotations', 'app.io/managed'], 'true');

      // The immutable observed annotations are still visible via getObserved,
      // and can be re-applied onto desired.
      const immutableKeys = ['serving.knative.dev/creator', 'serving.knative.dev/lastModifier'];
      for (const key of immutableKeys) {
        const value = comp.r.getObserved(['metadata', 'annotations', key]);
        expect(typeof value).toBe('string');
        comp.r.setDesired(['metadata', 'annotations', key], value);
      }

      const desired = getDesiredDocument(comp.r);
      expect((desired.metadata as Record<string, Record<string, unknown>>).annotations).toEqual({
        'app.io/managed': 'true',
        'serving.knative.dev/creator': 'system:admin',
        'serving.knative.dev/lastModifier': 'system:admin',
      });
    });
  });
});

describe('Resource nested auto-vivification (deep writes)', () => {
  it('auto-creates a missing intermediate under an existing desired object', () => {
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
      // `foo` is not set under spec — the deep write should auto-vivify it.
      (comp.r as AnyResource).spec!.foo!.bar = 'baz';
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ region: 'us-east-1', foo: { bar: 'baz' } });
    });
  });

  it('auto-creates several missing levels when nothing is set', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      (comp.r as AnyResource).spec!.a!.b = 'deep';
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ a: { b: 'deep' } });
    });
  });

  it("deep-writes through a bracketed dotted key (resource.spec['dotted.key'].bar)", () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      // Bracket access with a dotted key is a single property name (no splitting).
      (comp.r as AnyResource).spec!['config.io/opts']!.bar = 'baz';
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ 'config.io/opts': { bar: 'baz' } });
      // The dotted key is a single segment, addressable via array-form getDesired.
      expect(comp.r.getDesired(['spec', 'config.io/opts', 'bar'])).toBe('baz');
    });
  });

  it('merges into an existing plain object, preserving sibling keys', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            spec: { foo: { existing: 1 } },
          });
        }
      }
      const comp = new TestComp();
      (comp.r as AnyResource).spec!.foo!.bar = 'baz';
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ foo: { existing: 1, bar: 'baz' } });
    });
  });

  it('throws when deep-writing into a concrete primitive intermediate', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            spec: { foo: 'hello' },
          });
        }
      }
      const comp = new TestComp();
      // Proxy deep-write into a concrete primitive throws (native strict-mode error).
      expect(() => {
        (comp.r as AnyResource).spec!.foo!.bar = 'baz';
      }).toThrow();
      // setDesired routes through the collision policy and throws a descriptive error.
      expect(() => comp.r.setDesired('spec.foo.bar', 'baz')).toThrow(
        /Cannot deep-write into 'spec\.foo'/,
      );
    });
  });

  it('auto-vivifies desired when the path only exists in observed', () => {
    runInContext(() => {
      class TestComp extends Composition {
        r: Resource;
        constructor() {
          super();
          this.r = new Resource(this, 'cm', { apiVersion: 'v1', kind: 'ConfigMap' });
        }
      }
      const comp = new TestComp();
      hydrateObserved(comp.r, { spec: { existing: { fromObserved: true } } });
      (comp.r as AnyResource).spec!.added = 'value';
      const desired = getDesiredDocument(comp.r);
      expect(desired.spec).toEqual({ added: 'value' });
    });
  });
});
