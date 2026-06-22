import { describe, expect, it } from 'vitest';
import { parseOciRef } from '../ref.js';

describe('parseOciRef', () => {
  it('parses registry/repo:tag', () => {
    expect(parseOciRef('reg.io/foo/bar:v1')).toEqual({
      registry: 'reg.io',
      repository: 'foo/bar',
      reference: 'v1',
    });
  });

  it('parses registry/repo@digest', () => {
    expect(
      parseOciRef(
        'reg.io/foo/bar@sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
      ),
    ).toEqual({
      registry: 'reg.io',
      repository: 'foo/bar',
      reference: 'sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca',
    });
  });

  it('parses registry with port', () => {
    expect(parseOciRef('reg.io:5000/foo:v1')).toEqual({
      registry: 'reg.io:5000',
      repository: 'foo',
      reference: 'v1',
    });
  });

  it('throws on missing registry', () => {
    expect(() => parseOciRef('no-slash')).toThrow('missing registry');
  });

  it('throws on missing tag or digest', () => {
    expect(() => parseOciRef('reg.io/foo')).toThrow('missing tag or digest');
  });
});
