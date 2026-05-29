import { describe, expect, it } from 'vitest';

import {
  createPrimitiveReadProxy,
  createReadProxy,
  getReadProxyMeta,
  isReadProxy,
} from '../read-proxy.js';
import { createTokenRegistry, tokenRegistryStorage } from '../token-registry.js';
import type { ResourceRef } from '../types.js';

describe('ReadProxy', () => {
  const owner: ResourceRef = { id: 'vpc' };

  describe('isReadProxy', () => {
    it('returns false for null', () => {
      expect(isReadProxy(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isReadProxy(undefined)).toBe(false);
    });

    it('returns false for plain objects', () => {
      expect(isReadProxy({ foo: 'bar' })).toBe(false);
    });

    it('returns false for primitives', () => {
      expect(isReadProxy('str')).toBe(false);
      expect(isReadProxy(42)).toBe(false);
    });

    it('returns true for a ReadProxy', () => {
      const proxy = createReadProxy({ status: { id: '123' } }, owner, '');
      expect(isReadProxy(proxy)).toBe(true);
    });
  });

  describe('getReadProxyMeta', () => {
    it('returns undefined for non-proxy', () => {
      expect(getReadProxyMeta({})).toBeUndefined();
      expect(getReadProxyMeta(null)).toBeUndefined();
    });

    it('returns metadata for a ReadProxy', () => {
      const proxy = createReadProxy({ a: 1 }, owner, 'spec');
      const meta = getReadProxyMeta(proxy);
      expect(meta).toEqual({ owner, path: 'spec' });
    });
  });

  describe('createReadProxy', () => {
    it('wraps nested objects and accumulates path', () => {
      const data = { status: { atProvider: { vpcId: 'vpc-123' } } };
      const proxy = createReadProxy(data, owner, '');

      const status = (proxy as Record<string, unknown>).status;
      expect(isReadProxy(status)).toBe(true);
      expect(getReadProxyMeta(status)?.path).toBe('status');

      const atProvider = (status as Record<string, unknown>).atProvider;
      expect(getReadProxyMeta(atProvider)?.path).toBe('status.atProvider');
    });

    it('wraps primitives in PrimitiveReadProxy', () => {
      const data = { status: { id: 'vpc-123' } };
      const proxy = createReadProxy(data, owner, '');

      const id = (proxy as Record<string, unknown>).status;
      const vpcId = (id as Record<string, unknown>).id;
      expect(isReadProxy(vpcId)).toBe(true);

      // Can coerce to primitive
      expect(`${vpcId}`).toBe('vpc-123');
    });

    it('returns leaf proxy for undefined paths', () => {
      const data = {};
      const proxy = createReadProxy(data, owner, '');

      const missing = (proxy as Record<string, unknown>).nonexistent;
      expect(isReadProxy(missing)).toBe(true);
      expect(getReadProxyMeta(missing)?.path).toBe('nonexistent');
    });

    it('leaf proxy chains deeper accesses', () => {
      const data = {};
      const proxy = createReadProxy(data, owner, '');

      const deep = (proxy as Record<string, Record<string, Record<string, unknown>>>).a!.b!.c;
      expect(isReadProxy(deep)).toBe(true);
      expect(getReadProxyMeta(deep)?.path).toBe('a.b.c');
    });

    it('leaf proxy toJSON returns undefined', () => {
      const data = {};
      const proxy = createReadProxy(data, owner, '');
      const leaf = (proxy as Record<string, unknown>).missing;
      const toJSON = (leaf as Record<string, () => unknown>).toJSON;
      expect(toJSON!()).toBeUndefined();
    });

    it('has() returns true for READ_PROXY_TAG', () => {
      const proxy = createReadProxy({}, owner, '');
      expect(Symbol.for('xplane.readProxy') in proxy).toBe(true);
    });

    it('has() delegates to target for other props', () => {
      const data = { foo: 'bar' };
      const proxy = createReadProxy(data, owner, '');
      expect('foo' in proxy).toBe(true);
      expect('baz' in proxy).toBe(false);
    });

    it('toJSON returns the underlying object', () => {
      const data = { x: 1 };
      const proxy = createReadProxy(data, owner, '');
      const toJSON = (proxy as unknown as Record<string, () => unknown>).toJSON;
      expect(toJSON!()).toBe(data);
    });

    it('returns null/undefined directly for null values', () => {
      const data = { val: null };
      const proxy = createReadProxy(data, owner, '');
      const val = (proxy as Record<string, unknown>).val;
      // null goes through the leaf proxy path since value === null
      expect(isReadProxy(val)).toBe(true);
    });
  });

  describe('createPrimitiveReadProxy', () => {
    it('is detected as a ReadProxy', () => {
      const proxy = createPrimitiveReadProxy('hello', owner, 'spec.name');
      expect(isReadProxy(proxy)).toBe(true);
    });

    it('carries correct metadata', () => {
      const proxy = createPrimitiveReadProxy(42, owner, 'spec.count');
      const meta = getReadProxyMeta(proxy);
      expect(meta).toEqual({ owner, path: 'spec.count' });
    });

    it('coerces to string via Symbol.toPrimitive', () => {
      const proxy = createPrimitiveReadProxy('vpc-123', owner, 'status.id');
      expect(`${proxy}`).toBe('vpc-123');
    });

    it('valueOf returns the primitive', () => {
      const proxy = createPrimitiveReadProxy(99, owner, 'spec.port');
      expect((proxy as { valueOf: () => number }).valueOf()).toBe(99);
    });

    it('toString returns string representation', () => {
      const proxy = createPrimitiveReadProxy(true, owner, 'spec.enabled');
      expect((proxy as { toString: () => string }).toString()).toBe('true');
    });

    it('toJSON returns the primitive value', () => {
      const proxy = createPrimitiveReadProxy('val', owner, 'x');
      expect((proxy as { toJSON: () => unknown }).toJSON()).toBe('val');
    });

    it('navigating into a primitive returns a leaf proxy', () => {
      const proxy = createPrimitiveReadProxy('str', owner, 'x') as Record<string, unknown>;
      const nested = proxy.deeper;
      expect(isReadProxy(nested)).toBe(true);
      expect(getReadProxyMeta(nested)?.path).toBe('x.deeper');
    });

    it('has() returns false for arbitrary props', () => {
      const proxy = createPrimitiveReadProxy('str', owner, 'x');
      expect('foo' in proxy).toBe(false);
    });

    it('has() returns false for non-READ_PROXY_TAG symbols', () => {
      const proxy = createPrimitiveReadProxy('str', owner, 'x');
      expect(Symbol.iterator in (proxy as object)).toBe(false);
    });
  });

  describe('leaf proxy (chained access on missing paths)', () => {
    it('has() returns true for READ_PROXY_TAG', () => {
      const proxy = createReadProxy({} as object, owner, 'missing');
      // Access a non-existent nested prop to get a leaf proxy
      const leaf = (proxy as Record<string, unknown>).deep;
      expect(isReadProxy(leaf)).toBe(true);
    });

    it('has() returns false for non-tag symbols on leaf', () => {
      const proxy = createReadProxy({} as object, owner, 'path');
      const leaf = (proxy as Record<string, unknown>).nested;
      expect(Symbol.iterator in (leaf as object)).toBe(false);
    });

    it('symbol access on leaf proxy returns undefined', () => {
      const proxy = createReadProxy({} as object, owner, 'path');
      const leaf = (proxy as Record<string, unknown>).nested;
      expect((leaf as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    });

    it('leaf proxy Symbol.toPrimitive returns fallback token when no registry', () => {
      const proxy = createReadProxy({} as object, owner, '');
      const leaf = (proxy as Record<string, unknown>).missing;
      const toPrim = (leaf as Record<symbol, () => unknown>)[Symbol.toPrimitive];
      expect(typeof toPrim).toBe('function');
      const result = toPrim!();
      expect(typeof result).toBe('string');
      expect((result as string).startsWith('__pending__')).toBe(true);
    });

    it('leaf proxy Symbol.toPrimitive returns registry token when registry active', () => {
      tokenRegistryStorage.run(createTokenRegistry(), () => {
        const proxy = createReadProxy({} as object, owner, '');
        const leaf = (proxy as Record<string, unknown>).missing;
        const toPrim = (leaf as Record<symbol, () => unknown>)[Symbol.toPrimitive];
        const result = toPrim!();
        expect(typeof result).toBe('string');
        expect((result as string).startsWith('__pending__tpl_')).toBe(true);
      });
    });

    it('leaf proxy toString returns the token', () => {
      const proxy = createReadProxy({} as object, owner, '');
      const leaf = (proxy as Record<string, unknown>).path;
      const toStringFn = (leaf as Record<string, () => unknown>).toString;
      expect(typeof toStringFn).toBe('function');
      const result = toStringFn!();
      expect(typeof result).toBe('string');
      expect((result as string).startsWith('__pending__')).toBe(true);
    });

    it('leaf proxy valueOf returns the proxy itself', () => {
      const proxy = createReadProxy({} as object, owner, '');
      const leaf = (proxy as Record<string, unknown>).path;
      const valueOfFn = (leaf as Record<string, () => unknown>).valueOf;
      expect(typeof valueOfFn).toBe('function');
      expect(valueOfFn!()).toBe(leaf);
    });
  });

  describe('primitive proxy navigation', () => {
    it('navigating into a primitive returns a leaf proxy', () => {
      const proxy = createPrimitiveReadProxy(42, owner, 'count');
      // Accessing a sub-property on a primitive proxy yields a leaf
      const sub = (proxy as Record<string, unknown>).nested;
      expect(isReadProxy(sub)).toBe(true);
    });

    it('symbol access on primitive proxy returns undefined for non-special symbols', () => {
      const proxy = createPrimitiveReadProxy('hello', owner, 'name');
      expect((proxy as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    });
  });
});
