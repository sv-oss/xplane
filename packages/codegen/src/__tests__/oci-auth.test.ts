import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOciAuth } from '../sources/oci-auth.js';

describe('resolveOciAuth', () => {
  let tmpDir: string;
  let homeDir: string;
  const originalDockerConfig = process.env.DOCKER_CONFIG;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-auth-test-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-auth-home-'));
    delete process.env.DOCKER_CONFIG;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    if (originalDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = originalDockerConfig;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('returns basic auth when --username and --password are set', () => {
    expect(resolveOciAuth({ username: 'alice', password: 's3cret' })).toEqual({
      type: 'basic',
      username: 'alice',
      password: 's3cret',
    });
  });

  it('returns bearer auth when --token is set', () => {
    expect(resolveOciAuth({ token: 'abc.def' })).toEqual({ type: 'bearer', token: 'abc.def' });
  });

  it('returns dockerConfig auth when --docker-config points at an existing file', () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, '{}');
    expect(resolveOciAuth({ 'docker-config': cfg })).toEqual({
      type: 'dockerConfig',
      configPath: cfg,
    });
  });

  it('throws when --docker-config points at a non-existent file', () => {
    expect(() => resolveOciAuth({ 'docker-config': '/nope/config.json' })).toThrow(
      'Docker config not found',
    );
  });

  it('throws when basic auth is missing --password', () => {
    expect(() => resolveOciAuth({ username: 'alice' })).toThrow(
      'Basic auth requires both --username and --password',
    );
  });

  it('throws when basic auth is missing --username', () => {
    expect(() => resolveOciAuth({ password: 's3cret' })).toThrow(
      'Basic auth requires both --username and --password',
    );
  });

  it('throws when multiple auth modes are combined', () => {
    expect(() => resolveOciAuth({ username: 'a', password: 'b', token: 't' })).toThrow(
      'mutually exclusive',
    );
    expect(() => resolveOciAuth({ token: 't', 'docker-config': '/x' })).toThrow(
      'mutually exclusive',
    );
  });

  it('auto-detects $DOCKER_CONFIG/config.json when set', () => {
    process.env.DOCKER_CONFIG = tmpDir;
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, '{}');
    expect(resolveOciAuth({})).toEqual({ type: 'dockerConfig', configPath: cfg });
  });

  it('falls back to ~/.docker/config.json when DOCKER_CONFIG is unset', () => {
    const dockerDir = path.join(homeDir, '.docker');
    fs.mkdirSync(dockerDir, { recursive: true });
    const cfg = path.join(dockerDir, 'config.json');
    fs.writeFileSync(cfg, '{}');
    expect(resolveOciAuth({})).toEqual({ type: 'dockerConfig', configPath: cfg });
  });

  it('falls back to ~/.docker/config.json when DOCKER_CONFIG path has no config.json', () => {
    process.env.DOCKER_CONFIG = tmpDir; // no config.json inside
    const dockerDir = path.join(homeDir, '.docker');
    fs.mkdirSync(dockerDir, { recursive: true });
    const cfg = path.join(dockerDir, 'config.json');
    fs.writeFileSync(cfg, '{}');
    expect(resolveOciAuth({})).toEqual({ type: 'dockerConfig', configPath: cfg });
  });

  it('returns undefined (anonymous) when no flags are set and no docker config exists', () => {
    // homeDir has no .docker, DOCKER_CONFIG unset
    expect(resolveOciAuth({})).toBeUndefined();
  });
});
