import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { Manifest, ManifestLayer } from '@xplane/oci';
import { OciRegistryClient } from '@xplane/oci';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OciLoader } from '../loader/oci.js';

vi.mock('@xplane/oci', () => ({
  OciRegistryClient: vi.fn(),
}));

const CACHE_ROOT = '/tmp/xplane-oci-cache';

const COMPOSITION_CODE = `class C extends Composition { constructor() { super(); } }
exports.run = (input) => runComposition(C, input);`;

interface MockClient {
  getManifest: ReturnType<typeof vi.fn>;
  downloadBlob: ReturnType<typeof vi.fn>;
  fetchBlob: ReturnType<typeof vi.fn>;
}

let currentClient: MockClient;
let constructorOpts: Array<Record<string, unknown>>;
/** Map of layer digest → tarball bytes returned by the mocked downloadBlob. */
let blobBytes: Map<string, Buffer>;

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
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  blobBytes.set(digest, bytes);
  return {
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    size: bytes.length,
    digest,
  };
}

function rawLayer(bytes: Buffer): ManifestLayer {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  blobBytes.set(digest, bytes);
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

describe('OciLoader', () => {
  const loader = new OciLoader();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-loader-test-'));
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
    vi.clearAllMocks();

    constructorOpts = [];
    blobBytes = new Map();
    currentClient = {
      getManifest: vi.fn(),
      downloadBlob: vi.fn(
        async ({ digest, targetPath }: { digest: string; targetPath: string }) => {
          const bytes = blobBytes.get(digest);
          if (!bytes) throw new Error(`test: no blob bytes registered for ${digest}`);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, bytes);
        },
      ),
      fetchBlob: vi.fn(),
    };
    class MockClientCtor {
      getManifest = currentClient.getManifest;
      downloadBlob = currentClient.downloadBlob;
      fetchBlob = currentClient.fetchBlob;
      constructor(opts: unknown) {
        constructorOpts.push(opts as Record<string, unknown>);
      }
    }
    vi.mocked(OciRegistryClient).mockImplementation(MockClientCtor as never);
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

    it('builds basic auth from username/password files and forwards to OciRegistryClient', async () => {
      const userFile = path.join(tmpDir, 'user');
      const passFile = path.join(tmpDir, 'pass');
      fs.writeFileSync(userFile, 'alice\n');
      fs.writeFileSync(passFile, 's3cret\n');
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({
        spec: {
          registry: 'reg',
          repository: 'repo',
          tag: 'v1',
          auth: { type: 'basic', usernamePath: userFile, passwordPath: passFile },
        },
      });

      expect(constructorOpts[0]).toMatchObject({
        registry: 'reg',
        repository: 'repo',
        auth: { type: 'basic', username: 'alice', password: 's3cret' },
      });
    });

    it('builds bearer auth from token file', async () => {
      const tokenFile = path.join(tmpDir, 'tok');
      fs.writeFileSync(tokenFile, 'abc.def.ghi\n');
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({
        spec: {
          registry: 'reg',
          repository: 'repo',
          tag: 'v1',
          auth: { type: 'token', tokenPath: tokenFile },
        },
      });

      expect(constructorOpts[0]?.auth).toEqual({ type: 'bearer', token: 'abc.def.ghi' });
    });

    it('forwards dockerConfig auth as a passthrough', async () => {
      const cfg = path.join(tmpDir, 'config.json');
      fs.writeFileSync(cfg, '{}');
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({
        spec: {
          registry: 'my.registry',
          repository: 'repo',
          tag: 'v1',
          auth: { type: 'dockerConfig', configPath: cfg },
        },
      });

      expect(constructorOpts[0]?.auth).toEqual({ type: 'dockerConfig', configPath: cfg });
    });
  });

  // ─── Manifest resolution ─────────────────────────────────────────────────

  describe('manifest resolution', () => {
    it('rejects manifests with zero layers', async () => {
      currentClient.getManifest.mockResolvedValue(manifestOf([]));
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 't' } }),
      ).rejects.toThrow('manifest has no layers');
    });

    it('rejects manifests with multiple layers', async () => {
      const a = rawLayer(Buffer.from('a'));
      const b = rawLayer(Buffer.from('b'));
      currentClient.getManifest.mockResolvedValue(manifestOf([a, b]));
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 't' } }),
      ).rejects.toThrow('expected exactly 1');
    });

    it('uses digest as reference when supplied', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({
        spec: {
          registry: 'r',
          repository: 'r',
          digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      });

      expect(currentClient.getManifest.mock.calls[0]![0]).toEqual({
        reference: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      });
    });
  });

  // ─── Tarball layer ───────────────────────────────────────────────────────

  describe('tarball layer', () => {
    it('extracts and evaluates the default index.js entry', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      const mod = await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1' },
      });

      expect(typeof mod.run).toBe('function');
    });

    it('honors a custom entryPoint', async () => {
      const tgz = makeTarball({ 'main.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      const mod = await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', entryPoint: 'main.js' },
      });

      expect(typeof mod.run).toBe('function');
    });

    it('throws if entryPoint is not present in the tarball', async () => {
      const tgz = makeTarball({ 'other.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }),
      ).rejects.toThrow('entry file not found in tarball');
    });
  });

  // ─── Unsupported layer type ──────────────────────────────────────────────

  describe('unsupported layer', () => {
    it('rejects layers that are not tar+gzip', async () => {
      const code = Buffer.from(COMPOSITION_CODE, 'utf-8');
      currentClient.getManifest.mockResolvedValue(manifestOf([rawLayer(code)]));

      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }),
      ).rejects.toThrow('unsupported layer mediaType');
    });
  });

  // ─── Caching ─────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('reuses cached layer on second load (no downloadBlob call)', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });
      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });

      expect(currentClient.getManifest).toHaveBeenCalledTimes(2);
      expect(currentClient.downloadBlob).toHaveBeenCalledTimes(1);
    });

    it('refetches when tag points at a new digest', async () => {
      const tgzA = makeTarball({ 'index.js': COMPOSITION_CODE });
      const tgzB = makeTarball({
        'index.js': `${COMPOSITION_CODE}\n// version 2`,
      });

      currentClient.getManifest
        .mockResolvedValueOnce(manifestOf([tarballLayer(tgzA)]))
        .mockResolvedValueOnce(manifestOf([tarballLayer(tgzB)]));

      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'latest' } });
      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'latest' } });

      expect(currentClient.downloadBlob).toHaveBeenCalledTimes(2);
    });

    it('rejects unknown tagPullPolicy values', async () => {
      await expect(
        loader.load({
          spec: { registry: 'r', repository: 'r', tag: 't', tagPullPolicy: 'Never' },
        }),
      ).rejects.toThrow('tagPullPolicy must be');
    });

    it('IfNotPresent skips getManifest and downloadBlob on cache hit', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      // First load primes the cache (and writes the tag pointer).
      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', tagPullPolicy: 'IfNotPresent' },
      });
      expect(currentClient.getManifest).toHaveBeenCalledTimes(1);
      expect(currentClient.downloadBlob).toHaveBeenCalledTimes(1);

      // Second load with IfNotPresent should short-circuit entirely.
      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'v1', tagPullPolicy: 'IfNotPresent' },
      });
      expect(currentClient.getManifest).toHaveBeenCalledTimes(1);
      expect(currentClient.downloadBlob).toHaveBeenCalledTimes(1);
    });

    it('IfNotPresent still resolves manifest when tag pointer is missing', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({
        spec: { registry: 'r', repository: 'r', tag: 'fresh', tagPullPolicy: 'IfNotPresent' },
      });

      expect(currentClient.getManifest).toHaveBeenCalledTimes(1);
      expect(currentClient.downloadBlob).toHaveBeenCalledTimes(1);
    });

    it('IfNotPresent falls through when extracted layer is missing on disk', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

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

      expect(currentClient.getManifest).toHaveBeenCalledTimes(2);
      expect(currentClient.downloadBlob).toHaveBeenCalledTimes(2);
    });

    it('default policy is Always (re-resolves manifest every load)', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));

      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });
      await loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } });

      expect(currentClient.getManifest).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Error propagation ───────────────────────────────────────────────────

  describe('error propagation', () => {
    it('surfaces getManifest errors from the client', async () => {
      currentClient.getManifest.mockRejectedValue(new Error('boom: 500'));
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }),
      ).rejects.toThrow('boom: 500');
    });

    it('surfaces downloadBlob errors from the client', async () => {
      const tgz = makeTarball({ 'index.js': COMPOSITION_CODE });
      currentClient.getManifest.mockResolvedValue(manifestOf([tarballLayer(tgz)]));
      currentClient.downloadBlob.mockRejectedValue(new Error('ECONNRESET'));
      await expect(
        loader.load({ spec: { registry: 'r', repository: 'r', tag: 'v1' } }),
      ).rejects.toThrow('ECONNRESET');
    });
  });
});
