import { describe, expect, it } from 'vitest';

import { createPrimitiveReadProxy, createReadProxy } from '../read-proxy.js';
import { Pending, type ResourceRef } from '../types.js';
import { createWriteProxy, EdgeCollector } from '../write-proxy.js';

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
});
