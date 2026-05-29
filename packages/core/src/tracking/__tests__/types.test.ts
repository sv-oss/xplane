import { describe, expect, it } from 'vitest';
import type { ResourceRef } from '../types.js';
import { Pending, PendingTemplate } from '../types.js';

describe('Pending', () => {
  const ref: ResourceRef = { id: 'vpc' };

  it('stores source and path', () => {
    const p = new Pending(ref, 'status.atProvider.vpcId');
    expect(p.source).toBe(ref);
    expect(p.path).toBe('status.atProvider.vpcId');
  });

  it('Pending.is() returns true for Pending instances', () => {
    const p = new Pending(ref, 'status.id');
    expect(Pending.is(p)).toBe(true);
  });

  it('Pending.is() returns false for null', () => {
    expect(Pending.is(null)).toBe(false);
  });

  it('Pending.is() returns false for undefined', () => {
    expect(Pending.is(undefined)).toBe(false);
  });

  it('Pending.is() returns false for plain objects', () => {
    expect(Pending.is({ source: ref, path: 'foo' })).toBe(false);
  });

  it('Pending.is() returns false for primitives', () => {
    expect(Pending.is('string')).toBe(false);
    expect(Pending.is(123)).toBe(false);
    expect(Pending.is(true)).toBe(false);
  });
});

describe('PendingTemplate', () => {
  const refA: ResourceRef = { id: 'res-a' };
  const refB: ResourceRef = { id: 'res-b' };

  it('stores parts and slots', () => {
    const pt = new PendingTemplate(['prefix-', '-suffix'], [{ source: refA, path: 'status.name' }]);
    expect(pt.parts).toEqual(['prefix-', '-suffix']);
    expect(pt.slots).toEqual([{ source: refA, path: 'status.name' }]);
  });

  it('PendingTemplate.is() returns true for instances', () => {
    const pt = new PendingTemplate(['a', 'b'], [{ source: refA, path: 'x' }]);
    expect(PendingTemplate.is(pt)).toBe(true);
  });

  it('PendingTemplate.is() returns false for null', () => {
    expect(PendingTemplate.is(null)).toBe(false);
  });

  it('PendingTemplate.is() returns false for undefined', () => {
    expect(PendingTemplate.is(undefined)).toBe(false);
  });

  it('PendingTemplate.is() returns false for plain objects', () => {
    expect(PendingTemplate.is({ parts: [], slots: [] })).toBe(false);
  });

  it('PendingTemplate.is() returns false for primitives', () => {
    expect(PendingTemplate.is('string')).toBe(false);
    expect(PendingTemplate.is(42)).toBe(false);
  });

  it('PendingTemplate.is() returns false for Pending instances', () => {
    const p = new Pending(refA, 'status.name');
    expect(PendingTemplate.is(p)).toBe(false);
  });

  it('supports multiple slots', () => {
    const pt = new PendingTemplate(
      ['', '-', '-end'],
      [
        { source: refA, path: 'a' },
        { source: refB, path: 'b' },
      ],
    );
    expect(pt.slots).toHaveLength(2);
    expect(pt.parts).toHaveLength(3);
  });
});
