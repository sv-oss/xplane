import { describe, expect, it } from 'vitest';
import { parseTarget } from '../watcher/target.js';

describe('parseTarget', () => {
  it('parses bare resource/name', () => {
    expect(parseTarget('xprojects/foo')).toEqual({ resource: 'xprojects', name: 'foo' });
  });

  it('parses resource.group/name', () => {
    expect(parseTarget('xprojects.platform.example.com/foo')).toEqual({
      resource: 'xprojects',
      group: 'platform.example.com',
      name: 'foo',
    });
  });

  it('parses resource.version.group/name', () => {
    expect(parseTarget('xprojects.v1alpha1.platform.example.com/foo')).toEqual({
      resource: 'xprojects',
      version: 'v1alpha1',
      group: 'platform.example.com',
      name: 'foo',
    });
  });

  it('treats v-prefixed-but-not-version segment as group', () => {
    // `vault` does not match /^v\d/ so it is part of the group.
    expect(parseTarget('xprojects.vault.example.com/foo')).toEqual({
      resource: 'xprojects',
      group: 'vault.example.com',
      name: 'foo',
    });
  });

  it('rejects missing slash', () => {
    expect(() => parseTarget('xprojects')).toThrow(/expected kubectl-style/);
  });

  it('rejects empty resource or name', () => {
    expect(() => parseTarget('/foo')).toThrow(/both resource and name/);
    expect(() => parseTarget('xprojects/')).toThrow(/both resource and name/);
  });
});
