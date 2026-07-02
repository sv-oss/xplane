import { describe, expect, it } from 'vitest';
import {
  createTokenRegistry,
  getOrCreateToken,
  lookupToken,
  processStringValue,
  tokenRegistryStorage,
} from '../token-registry.js';
import type { ResourceRef } from '../types.js';
import { PendingTemplate } from '../types.js';

const owner: ResourceRef = { id: 'test-resource' };
const owner2: ResourceRef = { id: 'other-resource' };

describe('getOrCreateToken', () => {
  it('returns null when no registry is active', () => {
    expect(getOrCreateToken(owner, 'spec.name')).toBeNull();
  });

  it('returns a token string when registry is active', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const token = getOrCreateToken(owner, 'spec.name');
      expect(token).toMatch(/^__pending__tpl_\d+__$/);
    });
  });

  it('returns the same token for the same owner/path pair', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'spec.name');
      const t2 = getOrCreateToken(owner, 'spec.name');
      expect(t1).toBe(t2);
    });
  });

  it('returns different tokens for different paths', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'spec.name');
      const t2 = getOrCreateToken(owner, 'spec.other');
      expect(t1).not.toBe(t2);
    });
  });

  it('returns different tokens for different owners', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'spec.name');
      const t2 = getOrCreateToken(owner2, 'spec.name');
      expect(t1).not.toBe(t2);
    });
  });

  it('increments counter across registrations', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'a');
      const t2 = getOrCreateToken(owner, 'b');
      expect(t1).toBe('__pending__tpl_0__');
      expect(t2).toBe('__pending__tpl_1__');
    });
  });
});

describe('lookupToken', () => {
  it('returns undefined when no registry is active', () => {
    expect(lookupToken('__pending__tpl_0__')).toBeUndefined();
  });

  it('returns meta for a registered token', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const token = getOrCreateToken(owner, 'spec.name')!;
      const meta = lookupToken(token);
      expect(meta).toEqual({ owner, path: 'spec.name' });
    });
  });

  it('returns undefined for unknown token', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      expect(lookupToken('__pending__tpl_999__')).toBeUndefined();
    });
  });
});

describe('processStringValue', () => {
  it('returns original string when no tokens present', () => {
    const result = processStringValue('hello world', () => {});
    expect(result).toBe('hello world');
  });

  it('returns original string when token not in registry', () => {
    // Token looks like a token but isn't registered
    const result = processStringValue('prefix-__pending__tpl_0__-suffix', () => {});
    expect(result).toBe('prefix-__pending__tpl_0__-suffix');
  });

  it('returns PendingTemplate for a string with one token', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const token = getOrCreateToken(owner, 'status.name')!;
      const value = `prefix-${token}-suffix`;
      const slots: Array<{ owner: ResourceRef; path: string }> = [];
      const result = processStringValue(value, (meta) => slots.push(meta));

      expect(PendingTemplate.is(result)).toBe(true);
      const pt = result as PendingTemplate;
      expect(pt.parts).toEqual(['prefix-', '-suffix']);
      expect(pt.slots).toHaveLength(1);
      expect(pt.slots[0]!.source).toBe(owner);
      expect(pt.slots[0]!.path).toBe('status.name');
      expect(slots).toHaveLength(1);
      expect(slots[0]!.path).toBe('status.name');
    });
  });

  it('returns PendingTemplate for a string with multiple tokens', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'a')!;
      const t2 = getOrCreateToken(owner2, 'b')!;
      const value = `${t1}---${t2}`;
      const result = processStringValue(value, () => {});

      expect(PendingTemplate.is(result)).toBe(true);
      const pt = result as PendingTemplate;
      expect(pt.parts).toEqual(['', '---', '']);
      expect(pt.slots).toHaveLength(2);
    });
  });

  it('handles token at start and end with no surrounding text', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const token = getOrCreateToken(owner, 'x')!;
      const result = processStringValue(token, () => {});

      expect(PendingTemplate.is(result)).toBe(true);
      const pt = result as PendingTemplate;
      expect(pt.parts).toEqual(['', '']);
    });
  });

  it('calls onSlot for each registered token found', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'a')!;
      const t2 = getOrCreateToken(owner2, 'b')!;
      const callCount = { n: 0 };
      processStringValue(`${t1} and ${t2}`, () => callCount.n++);
      expect(callCount.n).toBe(2);
    });
  });

  it('inlines concrete values and returns a plain string when every slot is resolved', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'status.id', 'fs-123')!;
      const t2 = getOrCreateToken(owner2, 'status.id', 'fsap-456')!;
      const slots: Array<{ owner: ResourceRef; path: string }> = [];
      const result = processStringValue(`${t1}::${t2}`, (meta) => slots.push(meta));

      expect(result).toBe('fs-123::fsap-456');
      expect(slots).toEqual([
        { owner, path: 'status.id', value: 'fs-123' },
        { owner: owner2, path: 'status.id', value: 'fsap-456' },
      ]);
    });
  });

  it('coerces non-string concrete values via String()', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'spec.size', 42)!;
      const t2 = getOrCreateToken(owner2, 'spec.enabled', true)!;
      const result = processStringValue(`n=${t1} on=${t2}`, () => {});
      expect(result).toBe('n=42 on=true');
    });
  });

  it('keeps pending slots and inlines known values in a mixed template', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const tKnown = getOrCreateToken(owner, 'status.id', 'fs-123')!;
      const tPending = getOrCreateToken(owner2, 'status.id')!;
      const result = processStringValue(`prefix-${tKnown}-mid-${tPending}-suffix`, () => {});

      expect(PendingTemplate.is(result)).toBe(true);
      const pt = result as PendingTemplate;
      expect(pt.parts).toEqual(['prefix-fs-123-mid-', '-suffix']);
      expect(pt.slots).toEqual([{ source: owner2, path: 'status.id' }]);
    });
  });

  it('preserves the first value when the same (owner, path) is re-registered', () => {
    tokenRegistryStorage.run(createTokenRegistry(), () => {
      const t1 = getOrCreateToken(owner, 'status.id', 'fs-first')!;
      const t2 = getOrCreateToken(owner, 'status.id', 'fs-second')!;
      expect(t1).toBe(t2);
      const result = processStringValue(`${t1}`, () => {});
      expect(result).toBe('fs-first');
    });
  });
});
