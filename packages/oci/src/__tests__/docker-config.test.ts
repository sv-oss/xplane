import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDockerConfigAuth } from '../docker-config.js';

describe('resolveDockerConfigAuth', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-dc-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(content: unknown): string {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify(content));
    return p;
  }

  it('resolves base64 auth by exact registry key', () => {
    const auth = Buffer.from('alice:s3cret').toString('base64');
    const p = writeConfig({ auths: { 'reg.io': { auth } } });
    expect(resolveDockerConfigAuth(p, 'reg.io')).toEqual({
      username: 'alice',
      password: 's3cret',
    });
  });

  it('resolves auth keyed by https:// URL', () => {
    const auth = Buffer.from('u:p').toString('base64');
    const p = writeConfig({ auths: { 'https://reg.io/v1/': { auth } } });
    expect(resolveDockerConfigAuth(p, 'reg.io')).toEqual({ username: 'u', password: 'p' });
  });

  it('resolves separate username/password fields', () => {
    const p = writeConfig({ auths: { 'reg.io': { username: 'bob', password: 'pw' } } });
    expect(resolveDockerConfigAuth(p, 'reg.io')).toEqual({ username: 'bob', password: 'pw' });
  });

  it('returns undefined when no entry matches', () => {
    const p = writeConfig({ auths: { 'other.io': { auth: 'eA==' } } });
    expect(resolveDockerConfigAuth(p, 'reg.io')).toBeUndefined();
  });

  it('returns undefined when auths is missing', () => {
    const p = writeConfig({});
    expect(resolveDockerConfigAuth(p, 'reg.io')).toBeUndefined();
  });

  it('throws on malformed base64 auth (no colon)', () => {
    const auth = Buffer.from('no-colon-here').toString('base64');
    const p = writeConfig({ auths: { 'reg.io': { auth } } });
    expect(() => resolveDockerConfigAuth(p, 'reg.io')).toThrow('Malformed docker config auth');
  });

  it('returns undefined for empty entry', () => {
    const p = writeConfig({ auths: { 'reg.io': {} } });
    expect(resolveDockerConfigAuth(p, 'reg.io')).toBeUndefined();
  });
});
