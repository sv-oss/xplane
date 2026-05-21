import { describe, expect, it } from 'vitest';
import type { ResourceRef } from '../types.js';
import { Pending } from '../types.js';

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
