import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OciLoader } from '../loader/oci.js';

vi.mock('oci-client', () => ({
  getManifest: vi.fn(),
  fetchLayer: vi.fn(),
  getAuthFromConfigFile: vi.fn(),
}));

import {
  fetchLayer,
  getAuthFromConfigFile,
  getManifest,
  type Manifest,
  type ManifestLayer,
} from 'oci-client';

const CACHE_ROOT = '/tmp/xplane-oci-cache';

const COMPOSITION_CODE = `class C extends Composition { constructor() { super(); } }
exports.run = (input) => runComposition(C, input);`;

function makeTarball(files: Record<string, string>): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-mktar-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const tarPath = path.join(tmp, 'out.tar');
  tar.c({ file: tarPath, cwd: tmp, sync: true }, Object.keys(files));
  const raw = fs.readFileSync(tarPath);
  fs.rmSync(tmp, { recursive: true, force: true });
  return zlib.gzipSync(raw);
}

function tarballLayer(bytes: Buffer): ManifestLayer {
  // digest stays stable per test by using a counter-based fake hash, but the
  // real hash is fine too — we just need a unique sha256-prefixed string.
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return {
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    size: bytes.length,
    digest,
  };
}

function rawLayer(bytes: Buffer): ManifestLayer {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return {
    mediaType: 'application/vnd.xplane.composition.v1',
    size: bytes.length,
    digest,
  };
}

function manifestOf(layers: ManifestLayer[]): Manifest {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.empty.v1+json',
      size: 2,
      digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    },
    layers,
  };
}

function blob(bytes: Buffer): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

describe('OciLoader', () => {
  const loader = new OciLoader();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-loader-test-'));
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
  });

  // ─── Input validation ────────────────────────────────────────────────────

  describe('input validation', () => {
    it('throws if spec is missing', async () => {
      await expect(loader.load({})).rejects.toThrow('input.spec must be an object');
    });

    it('throws if spec is not an object', async () => {
      await expect(loader.load({ spec: 'bad' } as never)).rejects.toThrow(
        'input.spec must be an object',
      );
    });

    it('throws if spec is an array', async () => {
      await expect(loader.load({ spec: [] } as never)).rejects.toThrow(
        'input.spec must be an object',
      );
    });

    it('throws if registry is missing', async () => {
      await expect(loader.load({ spec: { repository: 'r', tag: 't' } })).rejects.toThrow(
        'registry is required',
      );
    });

    it('throws if registry is empty', async () => {
      await expect(
        loader.load({ spec: { registry: '', repository: 'r', tag: 't' } }),
      ).rejects.toThrow('registry is required');
    });

    it('throws if repository is missing', async () => {
      await expect(loader.load({ spec: { registry: 'r', tag: 't' } })).rejects.toThrow(
        'repository is required',
      );
    });

    it('throws if neither tag nor digest is set', async () => {
      await expect(loader.load({ spec: { registry: 'r', repository: 'r' } })).rejects.toThrow(
        'one of `tag` or `digest` is required',
      );
    });

    it('throws if tag is not a string', async () => {
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 1 } }),
      ).rejects.toThrow('tag must be a non-empty string');
    });

    it('throws if digest is not a string', async () => {
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', digest: 1 } }),
      ).rejects.toThrow('digest must be a non-empty string');
    });

    it('throws if digest is missing sha256 prefix', async () => {
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', digest: 'abc123' } }),
      ).rejects.toThrow('digest must start with "sha256:"');
    });

    it('throws if entryPoint is not a string', async () => {
      await expect(
        loader.load({
          spec: { registry: 'r', repository: 'r', tag: 't', entryPoint: 5 },
        }),
      ).rejects.toThrow('entryPoint must be a non-empty string');
    });
  });

  // ─── Auth validation ─────────────────────────────────────────────────────

  describe('auth validation', () => {
    it('throws if auth is not an object', async () => {
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 't', auth: 'x' } }),
      ).rejects.toThrow('auth must be an object');
    });

    it('throws if auth.type is unknown', async () => {
      await expect(
        loader.load({
          spec: { registry: 'r', repository: 'r', tag: 't', auth: { type: 'bogus' } },
        }),
      ).rejects.toThrow('auth.type must be one of');
    });

    it('throws if basic auth is missing paths', async () => {
      await expect(
        loader.load({
          spec: {
            registry: 'r',
            repository: 'r',
            tag: 't',
            auth: { type: 'basic', usernamePath: '/x' },
          },
        }),
      ).rejects.toThrow('auth.basic requires usernamePath and passwordPath');
    });

    it('throws if token auth is missing tokenPath', async () => {
      await expect(
        loader.load({
          spec: { registry: 'r', repository: 'r', tag: 't', auth: { type: 'token' } },
        }),
      ).rejects.toThrow('auth.token requires tokenPath');
    });

    it('throws if dockerConfig auth is missing configPath', async () => {
      await expect(
        loader.load({
          spec: { registry: 'r', repository: 'r', tag: 't', auth: { type: 'dockerConfig' } },
        }),
      ).rejects.toThrow('auth.dockerConfig requires configPath');
    });

    it('throws when basic auth username file is missing', async () => {
      vi.mocked(getManifest).mockResolvedValue(manifestOf([rawLayer(Buffer.from('x'))]));
      await expect(
        loader.load({
          spec: {
            registry: 'r',
            repository: 'r',
            tag: 't',
            auth: {
              type: 'basic',
              usernamePath: '/nope/user',
              passwordPath: path.join(tmpDir, 'p'),
            },
          },
        }),
      ).rejects.toThrow('username file not found');
    });

    it('throws when token file is empty', async () => {
      const tokenFile = path.join(tmpDir, 'tok');
      fs.writeFileSync(tokenFile, '   \n');
      await expect(
        loader.load({
          spec: {
            registry: 'r',
            repository: 'r',
            tag: 't',
            auth: { type: 'token', tokenPath: tokenFile },
          },
        }),
      ).rejects.toThrow('token file is empty');
    });

    it('throws when docker config file is missing', async () => {
      await expect(
        loader.load({
          spec: {
            registry: 'r',
            repository: 'r',
            tag: 't',
            auth: { type: 'dockerConfig', configPath: '/nope/config.json' },
          },
        }),
      ).rejects.toThrow('docker config file not found');
    });

    it('passes built credentials through to getManifest and fetchLayer (basic)', async () => {
      const userFile = path.join(tmpDir, 'user');
      const passFile = path.join(tmpDir, 'pass');
      fs.writeFileSync(userFile, 'alice\n');
      fs.writeFileSync(passFile, 's3cret\n');
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({
        spec: {
          registry: 'reg',
          repository: 'repo',
          tag: 'v1',
          auth: { type: 'basic', usernamePath: userFile, passwordPath: passFile },
        },
      });

      const manifestOpts = vi.mocked(getManifest).mock.calls[0]![1];
      expect(manifestOpts?.authentication).toEqual({ username: 'alice', password: 's3cret' });
      const layerOpts = vi.mocked(fetchLayer).mock.calls[0]![3];
      expect(layerOpts?.authentication).toEqual({ username: 'alice', password: 's3cret' });
    });

    it('passes pre-encoded token through as `auth` field', async () => {
      const tokenFile = path.join(tmpDir, 'tok');
      fs.writeFileSync(tokenFile, 'YWxpY2U6c2VjcmV0\n');
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({
        spec: {
          registry: 'reg',
          repository: 'repo',
          tag: 'v1',
          auth: { type: 'token', tokenPath: tokenFile },
        },
      });

      expect(vi.mocked(getManifest).mock.calls[0]![1]?.authentication).toEqual({
        auth: 'YWxpY2U6c2VjcmV0',
      });
    });

    it('delegates to getAuthFromConfigFile for dockerConfig', async () => {
      const cfg = path.join(tmpDir, 'config.json');
      fs.writeFileSync(cfg, '{}');
      vi.mocked(getAuthFromConfigFile).mockReturnValue({ auth: 'ZGVyaXZlZA==' });
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({
        spec: {
          registry: 'my.registry',
          repository: 'repo',
          tag: 'v1',
          auth: { type: 'dockerConfig', configPath: cfg },
        },
      });

      expect(getAuthFromConfigFile).toHaveBeenCalledWith(cfg, 'my.registry');
      expect(vi.mocked(getManifest).mock.calls[0]![1]?.authentication).toEqual({
        auth: 'ZGVyaXZlZA==',
      });
    });
  });

  // ─── Manifest resolution ─────────────────────────────────────────────────

  describe('manifest resolution', () => {
    it('rejects manifests with zero layers', async () => {
      vi.mocked(getManifest).mockResolvedValue(manifestOf([]));
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 't' } }),
      ).rejects.toThrow('manifest has no layers');
    });

    it('rejects manifests with multiple layers', async () => {
      const a = rawLayer(Buffer.from('a'));
      const b = rawLayer(Buffer.from('b'));
      vi.mocked(getManifest).mockResolvedValue(manifestOf([a, b]));
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 't' } }),
      ).rejects.toThrow('expected exactly 1');
    });

    it('uses digest as reference when supplied', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({
        spec: {
          registry: 'r',
          repository: 'r',
          digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      });

      const ref = vi.mocked(getManifest).mock.calls[0]![0] as {
        reference: string;
      };
      expect(ref.reference).toBe(
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      );
    });
  });

  // ─── Tarball layer ───────────────────────────────────────────────────────

  describe('tarball layer', () => {
    it('extracts and evaluates the default index.js entry', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      const mod = await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1' },
      });

      expect(typeof mod.run).toBe('function');
    });

    it('honors a custom entryPoint', async () => {
      const tgz = makeTarball({ 'main.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      const mod = await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', entryPoint: 'main.js' },
      });

      expect(typeof mod.run).toBe('function');
    });

    it('throws if entryPoint is not present in the tarball', async () => {
      const tgz = makeTarball({ 'other.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }),
      ).rejects.toThrow('entry file not found in tarball');
    });
  });

  // ─── Unsupported layer type ──────────────────────────────────────────────

  describe('unsupported layer', () => {
    it('rejects layers that are not tar+gzip', async () => {
      const code = Buffer.from(COMPOSITION_CODE, 'utf-8');
      vi.mocked(getManifest).mockResolvedValue(manifestOf([rawLayer(code)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(code));

      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }),
      ).rejects.toThrow('unsupported layer mediaType');
    });
  });

  // ─── Caching ─────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('reuses cached layer on second load (no fetchLayer call)', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });
      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });

      expect(getManifest).toHaveBeenCalledTimes(2);
      expect(fetchLayer).toHaveBeenCalledTimes(1);
    });

    it('refetches when tag points at a new digest', async () => {
      const tgzA = makeTarball({ 'index.js': COMPOSITION_CODE });
      const tgzB = makeTarball({
        'index.js': `${COMPOSITION_CODE}\n// version 2`,
      });

      vi.mocked(getManifest)
        .mockResolvedValueOnce(manifestOf([tarballLayer(tgzA)]))
        .mockResolvedValueOnce(manifestOf([tarballLayer(tgzB)]));
      vi.mocked(fetchLayer).mockResolvedValueOnce(blob(tgzA)).mockResolvedValueOnce(blob(tgzB));

      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'latest' } });
      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'latest' } });

      expect(fetchLayer).toHaveBeenCalledTimes(2);
    });

    it('rejects unknown tagPullPolicy values', async () => {
      await expect(
        loader.load({
          spec: { registry: 'r', repository: 'r', tag: 't', tagPullPolicy: 'Never' },
        }),
      ).rejects.toThrow('tagPullPolicy must be');
    });

    it('IfNotPresent skips getManifest and fetchLayer on cache hit', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      // First load primes the cache (and writes the tag pointer).
      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', tagPullPolicy: 'IfNotPresent' },
      });
      expect(getManifest).toHaveBeenCalledTimes(1);
      expect(fetchLayer).toHaveBeenCalledTimes(1);

      // Second load with IfNotPresent should short-circuit entirely.
      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', tagPullPolicy: 'IfNotPresent' },
      });
      expect(getManifest).toHaveBeenCalledTimes(1);
      expect(fetchLayer).toHaveBeenCalledTimes(1);
    });

    it('IfNotPresent still resolves manifest when tag pointer is missing', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'fresh', tagPullPolicy: 'IfNotPresent' },
      });

      expect(getManifest).toHaveBeenCalledTimes(1);
      expect(fetchLayer).toHaveBeenCalledTimes(1);
    });

    it('IfNotPresent falls through when extracted layer is missing on disk', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', tagPullPolicy: 'IfNotPresent' },
      });

      // Wipe the extracted layer but keep the tag pointer.
      for (const entry of fs.readdirSync(CACHE_ROOT)) {
        if (entry === 'tags') continue;
        fs.rmSync(path.join(CACHE_ROOT, entry), { recursive: true, force: true });
      }

      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', tagPullPolicy: 'IfNotPresent' },
      });

      expect(getManifest).toHaveBeenCalledTimes(2);
      expect(fetchLayer).toHaveBeenCalledTimes(2);
    });

    it('default policy is Always (re-resolves manifest every load)', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });
      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });

      expect(getManifest).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Retries ─────────────────────────────────────────────────────────────

  describe('retries', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function runAndDrainTimers<T>(p: Promise<T>): Promise<T> {
      // Each retry awaits setTimeout; advance fake timers between attempts.
      let settled = false;
      // Attach a noop catch to mark the rejection as handled — callers re-await
      // the original promise via expect(...).rejects to assert on it.
      p.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      while (!settled) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      return p;
    }

    it('retries getManifest on transient failure and succeeds', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest)
        .mockRejectedValueOnce(new Error('Failed to fetch manifest: 404 Not Found'))
        .mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer).mockResolvedValue(blob(tgz));

      await runAndDrainTimers(loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }));

      expect(getManifest).toHaveBeenCalledTimes(2);
    });

    it('gives up after RETRY_ATTEMPTS and throws the last error', async () => {
      vi.mocked(getManifest).mockRejectedValue(new Error('Failed to fetch manifest: 500'));

      const p = loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });
      await expect(runAndDrainTimers(p)).rejects.toThrow('Failed to fetch manifest: 500');

      expect(getManifest).toHaveBeenCalledTimes(3);
    });

    it('retries fetchLayer on transient failure and succeeds', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      vi.mocked(getManifest).mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      vi.mocked(fetchLayer)
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue(blob(tgz));

      await runAndDrainTimers(loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }));

      expect(fetchLayer).toHaveBeenCalledTimes(2);
    });

    it('rethrows non-Error rejection after exhausting retries', async () => {
      vi.mocked(getManifest).mockRejectedValue('string-failure');

      const p = loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });
      await expect(runAndDrainTimers(p)).rejects.toBe('string-failure');
      expect(getManifest).toHaveBeenCalledTimes(3);
    });
  });
});
