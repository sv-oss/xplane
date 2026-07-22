import { describe, expect, it } from 'vitest';

import { createPrimitiveReadProxy, createReadProxy, isReadProxy } from '../read-proxy.js';
import { createTokenRegistry, tokenRegistryStorage } from '../token-registry.js';
import { Pending, PendingMerge, PendingTemplate, type ResourceRef } from '../types.js';
import {
  createLazyWriteProxy,
  createWriteProxy,
  EdgeCollector,
  ensureChildContainer,
  resolveAssignedValue,
} from '../write-proxy.js';

describe('EdgeCollector', () => {
  it('collects edges', () => {
    const collector = new EdgeCollector();
    const edge = { from: { id: 'a' }, fromPath: 'x', to: { id: 'b' }, toPath: 'y' };
    collector.add(edge);
    expect(collector.edges).toHaveLength(1);
    expect(collector.edges[0]).toEqual(edge);
  });

  it('deduplicates identical edges', () => {
    const collector = new EdgeCollector();
    const edge = { from: { id: 'a' }, fromPath: 'x', to: { id: 'b' }, toPath: 'y' };
    collector.add(edge);
    collector.add(edge);
    collector.add({ ...edge });
    expect(collector.edges).toHaveLength(1);
  });

  it('keeps distinct edges', () => {
    const collector = new EdgeCollector();
    collector.add({ from: { id: 'a' }, fromPath: 'x', to: { id: 'b' }, toPath: 'y' });
    collector.add({ from: { id: 'a' }, fromPath: 'x', to: { id: 'b' }, toPath: 'z' });
    expect(collector.edges).toHaveLength(2);
  });
});

describe('WriteProxy', () => {
  const owner: ResourceRef = { id: 'subnet' };
  const vpcRef: ResourceRef = { id: 'vpc' };

  function setup() {
    const collector = new EdgeCollector();
    const target: Record<string, unknown> = {};
    const proxy = createWriteProxy(target, { owner, collector });
    return { collector, target, proxy };
  }

  it('writes plain values to target', () => {
    const { proxy, target } = setup();
    (proxy as Record<string, unknown>).name = 'my-subnet';
    expect(target.name).toBe('my-subnet');
  });

  it('writes null and undefined', () => {
    const { proxy, target } = setup();
    (proxy as Record<string, unknown>).a = null;
    (proxy as Record<string, unknown>).b = undefined;
    expect(target.a).toBeNull();
    expect(target.b).toBeUndefined();
  });

  it('records edge when assigning a PrimitiveReadProxy', () => {
    const { proxy, collector, target } = setup();
    const readProxy = createPrimitiveReadProxy('vpc-123', vpcRef, 'status.vpcId');
    (proxy as Record<string, unknown>).vpcId = readProxy;

    expect(collector.edges).toHaveLength(1);
    expect(collector.edges[0]).toEqual({
      from: vpcRef,
      fromPath: 'status.vpcId',
      to: owner,
      toPath: 'vpcId',
    });
    // Concrete value extracted
    expect(target.vpcId).toBe('vpc-123');
  });

  it('stores Pending when assigning a leaf ReadProxy (no concrete value)', () => {
    const { proxy, collector, target } = setup();
    const observed = {};
    const readProxy = createReadProxy(observed, vpcRef, '');
    const leaf = (readProxy as Record<string, Record<string, unknown>>).status!.vpcId;

    (proxy as Record<string, unknown>).vpcId = leaf;

    expect(collector.edges).toHaveLength(1);
    expect(Pending.is(target.vpcId)).toBe(true);
    const pending = target.vpcId as Pending;
    expect(pending.source.id).toBe('vpc');
    expect(pending.path).toBe('status.vpcId');
  });

  it('records edge when assigning object ReadProxy', () => {
    const { proxy, collector } = setup();
    const data = { atProvider: { id: 'sub-1' } };
    const readProxy = createReadProxy(data, vpcRef, 'status');

    (proxy as Record<string, unknown>).ref = readProxy;

    expect(collector.edges).toHaveLength(1);
    expect(collector.edges[0]!.fromPath).toBe('status');
  });

  it('reads return nested WriteProxy for objects', () => {
    const collector = new EdgeCollector();
    const target: Record<string, unknown> = { spec: { forProvider: {} } };
    const proxy = createWriteProxy(target, { owner, collector });

    const spec = (proxy as Record<string, Record<string, unknown>>).spec!;
    spec.region = 'us-east-1';
    expect((target.spec as Record<string, unknown>).region).toBe('us-east-1');
  });

  it('deep processes plain objects assigned with nested ReadProxy', () => {
    const { proxy, collector, target } = setup();
    const readVal = createPrimitiveReadProxy('vpc-123', vpcRef, 'status.vpcId');

    (proxy as Record<string, unknown>).config = { nested: { ref: readVal } };

    expect(collector.edges).toHaveLength(1);
    const config = target.config as Record<string, Record<string, unknown>>;
    expect(config.nested!.ref).toBe('vpc-123');
  });

  it('deep processes arrays with ReadProxy values', () => {
    const { proxy, collector, target } = setup();
    const readVal = createPrimitiveReadProxy('sg-1', vpcRef, 'status.sgId');

    (proxy as Record<string, unknown>).securityGroups = [readVal, 'sg-2'];

    expect(collector.edges).toHaveLength(1);
    expect(target.securityGroups).toEqual(['sg-1', 'sg-2']);
  });

  it('handles basePath for nested writes', () => {
    const collector = new EdgeCollector();
    const target: Record<string, unknown> = {};
    const proxy = createWriteProxy(target, { owner, collector, basePath: 'spec.forProvider' });

    const readVal = createPrimitiveReadProxy('vpc-123', vpcRef, 'status.vpcId');
    (proxy as Record<string, unknown>).vpcId = readVal;

    expect(collector.edges[0]!.toPath).toBe('spec.forProvider.vpcId');
  });

  it('toJSON returns the target object', () => {
    const collector = new EdgeCollector();
    const target = { a: 1 };
    const proxy = createWriteProxy(target, { owner, collector });
    expect((proxy as Record<string, unknown>).toJSON).toBeTypeOf('function');
    expect((proxy as unknown as Record<string, () => unknown>).toJSON!()).toBe(target);
  });

  it('deleteProperty works', () => {
    const collector = new EdgeCollector();
    const target: Record<string, unknown> = { a: 1, b: 2 };
    const proxy = createWriteProxy(target, { owner, collector });
    delete (proxy as Record<string, unknown>).a;
    expect('a' in target).toBe(false);
  });

  it('self-reference ReadProxy extracts primitive without edge if same owner', () => {
    const collector = new EdgeCollector();
    const target: Record<string, unknown> = {};
    const proxy = createWriteProxy(target, { owner, collector });

    // Same owner
    const readVal = createPrimitiveReadProxy('val', owner, 'spec.x');
    (proxy as Record<string, unknown>).y = readVal;

    // No edge (self-reference)
    expect(collector.edges).toHaveLength(0);
    expect(target.y).toBe('val');
  });

  it('stores Pending for leaf ReadProxy on self-reference', () => {
    const collector = new EdgeCollector();
    const target: Record<string, unknown> = {};
    const proxy = createWriteProxy(target, { owner, collector });

    // Self-referencing leaf (no concrete value)
    const leaf = createReadProxy({}, owner, '');
    const val = (leaf as Record<string, Record<string, unknown>>).status!.missing;
    (proxy as Record<string, unknown>).x = val;

    // Edge IS recorded for self-references on XR-like patterns
    expect(Pending.is(target.x)).toBe(true);
  });

  it('handles symbol props on get and set', () => {
    const collector = new EdgeCollector();
    const target: Record<string | symbol, unknown> = {};
    const proxy = createWriteProxy(target, { owner, collector });
    const sym = Symbol('test');
    (proxy as Record<symbol, unknown>)[sym] = 'val';
    expect(target[sym]).toBe('val');
    expect((proxy as Record<symbol, unknown>)[sym]).toBe('val');
  });

  it('deep processes arrays containing ReadProxy values', () => {
    const target: Record<string, unknown> = {};
    const collector = new EdgeCollector();
    const owner: ResourceRef = { id: 'dst' };
    const srcOwner: ResourceRef = { id: 'src' };
    const proxy = createWriteProxy(target, { owner, collector });

    const readProxy = createReadProxy({ val: 'hello' } as object, srcOwner, 'status.items');
    (proxy as Record<string, unknown>).list = [readProxy, 'plain'];

    expect(collector.edges.length).toBe(1);
    const stored = target.list as unknown[];
    // First item should be a Pending (ReadProxy with object → can't extract primitive)
    expect(Pending.is(stored[0])).toBe(true);
    expect(stored[1]).toBe('plain');
  });

  it('get returns primitive values directly', () => {
    const target = { count: 42, name: 'test' };
    const collector = new EdgeCollector();
    const owner: ResourceRef = { id: 'r1' };
    const proxy = createWriteProxy(target, { owner, collector });

    expect((proxy as Record<string, unknown>).count).toBe(42);
    expect((proxy as Record<string, unknown>).name).toBe('test');
  });

  it('falls through to observed for missing keys when observed is provided', () => {
    const target = { labels: { app: 'test' } };
    const observed = { labels: { app: 'test' }, name: 'generated-name-abc123' };
    const collector = new EdgeCollector();
    const proxy = createWriteProxy(target, { owner, collector, basePath: 'metadata', observed });

    // Access a key that exists in observed but not in desired target
    const nameValue = (proxy as Record<string, unknown>).name;
    // Should be a ReadProxy (object with toPrimitive)
    expect(nameValue).toBeDefined();
    expect(typeof nameValue).toBe('object');
    const prim = (nameValue as { [Symbol.toPrimitive]: () => unknown })[Symbol.toPrimitive]();
    expect(prim).toBe('generated-name-abc123');
  });

  it('falls through to observed ReadProxy for nested objects', () => {
    const target = { labels: { app: 'test' } };
    const observed = { labels: { app: 'test' }, nested: { foo: 'bar' } };
    const collector = new EdgeCollector();
    const proxy = createWriteProxy(target, { owner, collector, basePath: 'metadata', observed });

    const nestedValue = (proxy as Record<string, unknown>).nested;
    expect(nestedValue).toBeDefined();
    expect(typeof nestedValue).toBe('object');
    // Accessing a property on the ReadProxy should continue tracking
    const fooValue = (nestedValue as Record<string, unknown>).foo;
    expect(fooValue).toBeDefined();
  });

  it('returns a lazy-write proxy for unset paths so nested writes auto-vivify', () => {
    const target: Record<string, unknown> = { labels: { app: 'test' } };
    const collector = new EdgeCollector();
    const proxy = createWriteProxy(target, { owner, collector, basePath: 'metadata' });

    // Reading an unset path yields a ReadProxy (not `undefined`) so that deep
    // writes can auto-initialize the intermediate objects in the desired doc.
    const nameValue = (proxy as Record<string, unknown>).name;
    expect(isReadProxy(nameValue)).toBe(true);

    // A nested write through the unset path auto-vivifies into the target.
    (proxy as Record<string, Record<string, unknown>>).annotations!.team = 'platform';
    expect(target.annotations).toEqual({ team: 'platform' });
  });

  it('passes observed down to nested WriteProxy children', () => {
    const target = { metadata: { labels: { app: 'test' } } };
    const observed = { metadata: { labels: { app: 'test' }, name: 'auto-generated' } };
    const collector = new EdgeCollector();
    const proxy = createWriteProxy(target, { owner, collector, observed });

    // Access metadata (nested WriteProxy) then name (fallback to observed)
    const metadata = (proxy as Record<string, unknown>).metadata as Record<string, unknown>;
    const nameValue = metadata.name;
    expect(nameValue).toBeDefined();
    expect(typeof nameValue).toBe('object');
    const prim = (nameValue as { [Symbol.toPrimitive]: () => unknown })[Symbol.toPrimitive]();
    expect(prim).toBe('auto-generated');
  });

  it('stores PendingTemplate when assigning a string with pending tokens', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const { proxy, collector, target } = setup();
      const observed = {};
      const readProxy = createReadProxy(observed, vpcRef, '');
      const leaf = (readProxy as Record<string, Record<string, unknown>>).status!.name;

      // When leaf is used in a template literal, it produces a token
      const templateStr = `prefix-${leaf}-suffix`;
      (proxy as Record<string, unknown>).name = templateStr;

      // Should produce a PendingTemplate
      expect(PendingTemplate.is(target.name)).toBe(true);
      const pt = target.name as PendingTemplate;
      expect(pt.parts).toEqual(['prefix-', '-suffix']);
      expect(pt.slots[0]!.path).toBe('status.name');
      expect(collector.edges).toHaveLength(1);
    });
  });

  it('stores PendingTemplate in deepProcessValue for nested string with tokens', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const collector = new EdgeCollector();
      const target: Record<string, unknown> = {};
      const srcOwner: ResourceRef = { id: 'src' };
      const dstOwner: ResourceRef = { id: 'dst' };
      const proxy = createWriteProxy(target, { owner: dstOwner, collector });

      const readProxy = createReadProxy({} as object, srcOwner, '');
      const leaf = (readProxy as Record<string, Record<string, unknown>>).metadata!.name;
      const templateStr = `${leaf}.example.com`;

      // Assign via a nested object so deepProcessValue is exercised
      (proxy as Record<string, unknown>).spec = { host: templateStr };

      const spec = target.spec as Record<string, unknown>;
      expect(PendingTemplate.is(spec.host)).toBe(true);
      expect(collector.edges).toHaveLength(1);
    });
  });
});

describe('ensureChildContainer (deep-write collision policy)', () => {
  it('creates a fresh object for unset or null intermediates', () => {
    const parent: Record<string, unknown> = { nullish: null };
    const created = ensureChildContainer(parent, 'missing', 'a.missing');
    expect(created).toEqual({});
    expect(parent.missing).toBe(created);
    expect(ensureChildContainer(parent, 'nullish', 'a.nullish')).toEqual({});
  });

  it('returns an existing plain object to merge into', () => {
    const existing = { keep: 1 };
    const parent: Record<string, unknown> = { obj: existing };
    expect(ensureChildContainer(parent, 'obj', 'a.obj')).toBe(existing);
  });

  it('converts a Pending intermediate into a PendingMerge', () => {
    const parent: Record<string, unknown> = { ref: new Pending({ id: 'src' }, 'spec.foo') };
    const overrides = ensureChildContainer(parent, 'ref', 'a.ref');
    const merged = parent.ref;
    expect(PendingMerge.is(merged)).toBe(true);
    expect((merged as PendingMerge).source.id).toBe('src');
    expect((merged as PendingMerge).path).toBe('spec.foo');
    expect((merged as PendingMerge).overrides).toBe(overrides);
  });

  it('returns the overrides of an existing PendingMerge', () => {
    const overrides = { bar: 1 };
    const parent: Record<string, unknown> = {
      m: new PendingMerge({ id: 'src' }, 'spec.foo', overrides),
    };
    expect(ensureChildContainer(parent, 'm', 'a.m')).toBe(overrides);
  });

  it('throws for a PendingTemplate intermediate', () => {
    const parent: Record<string, unknown> = {
      t: new PendingTemplate(['a-', '-b'], [{ source: { id: 's' }, path: 'p' }]),
    };
    expect(() => ensureChildContainer(parent, 't', 'a.t')).toThrow(/computed template string/);
  });

  it('throws for primitive and array intermediates', () => {
    const parent: Record<string, unknown> = { s: 'hi', arr: [1, 2] };
    expect(() => ensureChildContainer(parent, 's', 'a.s')).toThrow(/already holds a string/);
    expect(() => ensureChildContainer(parent, 'arr', 'a.arr')).toThrow(/already holds an array/);
  });
});

describe('createLazyWriteProxy', () => {
  const owner: ResourceRef = { id: 'res' };

  it('materializes deep paths only on write', () => {
    const desired: Record<string, unknown> = {};
    const collector = new EdgeCollector();
    const proxy = createLazyWriteProxy({
      owner,
      collector,
      path: 'spec',
      target: createReadProxy(Object.create(null) as object, owner, 'spec'),
      materialize: () => ensureChildContainer(desired, 'spec', 'spec'),
    }) as Record<string, Record<string, unknown>>;

    // Reading does not pollute the desired document.
    void proxy.foo!.bar;
    expect(desired).toEqual({});

    // Writing materializes the whole chain.
    proxy.foo!.bar = 'baz';
    expect(desired).toEqual({ spec: { foo: { bar: 'baz' } } });
  });

  it('is recognized as a ReadProxy and coerces observed leaves', () => {
    const desired: Record<string, unknown> = {};
    const collector = new EdgeCollector();
    const observed = { id: 'obs-1' };
    const proxy = createLazyWriteProxy({
      owner,
      collector,
      path: 'status',
      target: createReadProxy(observed, owner, 'status'),
      materialize: () => ensureChildContainer(desired, 'status', 'status'),
    }) as Record<string, unknown>;

    expect(isReadProxy(proxy)).toBe(true);
    expect(`${proxy.id}`).toBe('obs-1');
  });

  it('reflects observed keys through the has trap', () => {
    const desired: Record<string, unknown> = {};
    const collector = new EdgeCollector();
    const proxy = createLazyWriteProxy({
      owner,
      collector,
      path: 'status',
      target: createReadProxy({ id: 'obs-1' }, owner, 'status'),
      materialize: () => ensureChildContainer(desired, 'status', 'status'),
    });

    expect('id' in proxy).toBe(true);
    expect('missing' in proxy).toBe(false);
  });
});

describe('resolveAssignedValue', () => {
  const owner: ResourceRef = { id: 'dst' };

  it('records an edge and stores a Pending for an unresolved cross-resource ref', () => {
    const collector = new EdgeCollector();
    const leaf = (
      createReadProxy(Object.create(null) as object, { id: 'src' }, '') as Record<string, unknown>
    ).name;
    const result = resolveAssignedValue(leaf, owner, 'spec.name', collector);
    expect(Pending.is(result)).toBe(true);
    expect(collector.edges).toHaveLength(1);
  });

  it('inlines a concrete primitive from an observed ref', () => {
    const collector = new EdgeCollector();
    const prim = createPrimitiveReadProxy('v', { id: 'src' }, 'spec.v');
    expect(resolveAssignedValue(prim, owner, 'spec.v', collector)).toBe('v');
  });

  it('passes primitives and pending markers through untouched', () => {
    const collector = new EdgeCollector();
    expect(resolveAssignedValue(42, owner, 'spec.n', collector)).toBe(42);
    const pending = new Pending({ id: 'src' }, 'x');
    expect(resolveAssignedValue(pending, owner, 'spec.p', collector)).toBe(pending);
  });
});
