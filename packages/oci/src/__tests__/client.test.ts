import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OciRegistryClient } from '../client.js';
import { OciRegistryError } from '../types.js';

// ─── Fetch mocking helpers ─────────────────────────────────────────────────

interface MockCall {
  url: string;
  init?: RequestInit;
}

interface FetchHarness {
  fetch: typeof fetch;
  calls: MockCall[];
  reset(): void;
}

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

function harness(responder: Responder): FetchHarness {
  const calls: MockCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return {
    fetch: fn,
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
}

function jsonRes(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function manifestRes(layers: Array<Record<string, unknown>>): Response {
  return jsonRes({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', size: 2, digest: 'sha256:0' },
    layers,
  });
}

function indexRes(manifests: Array<Record<string, unknown>>): Response {
  return jsonRes({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests,
  });
}

const DIGEST = 'sha256:abc';
const REG = 'reg.io';
const REPO = 'foo/bar';
const MANIFEST_URL = (ref: string) => `https://${REG}/v2/${REPO}/manifests/${ref}`;
const BLOB_URL = (d: string) => `https://${REG}/v2/${REPO}/blobs/${d}`;

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('OciRegistryClient.getManifest', () => {
  it('returns a single-arch manifest', async () => {
    const h = harness(() => manifestRes([{ mediaType: 'x', size: 1, digest: DIGEST }]));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    const m = await c.getManifest({ reference: 'v1' });
    expect(m.layers).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(MANIFEST_URL('v1'));
  });

  it('sends the default Accept header set', async () => {
    const h = harness(() => manifestRes([]));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await c.getManifest({ reference: 'v1' });
    const accept = new Headers(h.calls[0]!.init?.headers).get('accept');
    expect(accept).toContain('application/vnd.oci.image.manifest.v1+json');
    expect(accept).toContain('application/vnd.oci.image.index.v1+json');
  });

  it('resolves an index manifest to the matching platform', async () => {
    const archDigest = 'sha256:arm64';
    const h = harness((url) => {
      if (url === MANIFEST_URL('v1')) {
        return indexRes([
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: 'sha256:amd64',
            size: 1,
            platform: { os: 'linux', architecture: 'amd64' },
          },
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: archDigest,
            size: 1,
            platform: { os: 'linux', architecture: 'arm64' },
          },
        ]);
      }
      if (url === MANIFEST_URL(archDigest)) {
        return manifestRes([{ mediaType: 'x', size: 1, digest: DIGEST }]);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    const m = await c.getManifest({ reference: 'v1', platform: 'linux/arm64' });
    expect(m.layers).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
  });

  it('throws when index is returned without a platform option', async () => {
    const h = harness(() =>
      indexRes([
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: 'sha256:a',
          size: 1,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ]),
    );
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.getManifest({ reference: 'v1' })).rejects.toThrow(
      /Registry returned an image index/,
    );
  });

  it('throws when no descriptor matches the requested platform', async () => {
    const h = harness(() =>
      indexRes([
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: 'sha256:a',
          size: 1,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ]),
    );
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.getManifest({ reference: 'v1', platform: 'linux/arm64' })).rejects.toThrow(
      /No manifest for platform linux\/arm64/,
    );
  });

  it('throws on empty index manifests', async () => {
    const h = harness(() => indexRes([]));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.getManifest({ reference: 'v1' })).rejects.toThrow(/no layers or descriptors/);
  });

  it('throws on invalid platform string', async () => {
    const h = harness(() =>
      indexRes([
        {
          mediaType: 'x',
          digest: 'sha256:a',
          size: 1,
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ]),
    );
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.getManifest({ reference: 'v1', platform: 'bogus' })).rejects.toThrow(
      /Invalid platform/,
    );
  });
});

describe('OciRegistryClient auth', () => {
  it('sends Basic auth when configured', async () => {
    const h = harness(() => manifestRes([]));
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'basic', username: 'u', password: 'p' },
    });
    await c.getManifest({ reference: 'v1' });
    const authHeader = new Headers(h.calls[0]!.init?.headers).get('authorization');
    expect(authHeader).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('sends pre-acquired Bearer token when configured', async () => {
    const h = harness(() => manifestRes([]));
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'bearer', token: 'preset' },
    });
    await c.getManifest({ reference: 'v1' });
    expect(new Headers(h.calls[0]!.init?.headers).get('authorization')).toBe('Bearer preset');
  });

  it('handles a Bearer challenge: exchanges for a token and retries', async () => {
    let step = 0;
    const h = harness((url) => {
      step++;
      if (step === 1) {
        // First call: 401 with bearer challenge
        return new Response(JSON.stringify({ errors: [] }), {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer realm="https://auth.reg.io/token",service="reg.io",scope="repository:foo/bar:pull"',
          },
        });
      }
      if (step === 2) {
        // Token exchange
        expect(url).toContain('https://auth.reg.io/token');
        expect(url).toContain('service=reg.io');
        expect(url).toContain('scope=repository%3Afoo%2Fbar%3Apull');
        return jsonRes({ token: 'fresh-token' });
      }
      // Retry with Bearer
      return manifestRes([{ mediaType: 'x', size: 1, digest: DIGEST }]);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    const m = await c.getManifest({ reference: 'v1' });
    expect(m.layers).toHaveLength(1);
    const retryAuth = new Headers(h.calls[2]!.init?.headers).get('authorization');
    expect(retryAuth).toBe('Bearer fresh-token');
  });

  it('accepts access_token alias from token endpoint', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.x/token"' },
        });
      }
      if (step === 2) return jsonRes({ access_token: 'alt-token' });
      return manifestRes([]);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await c.getManifest({ reference: 'v1' });
    expect(new Headers(h.calls[2]!.init?.headers).get('authorization')).toBe('Bearer alt-token');
  });

  it('caches the bearer token for subsequent calls', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer realm="https://auth.x/token",scope="repository:foo/bar:pull"',
          },
        });
      }
      if (step === 2) return jsonRes({ token: 'cached-token' });
      return manifestRes([]);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await c.getManifest({ reference: 'v1' });
    await c.getManifest({ reference: 'v2' });
    // 1 (401) + 1 (token) + 1 (retry) + 1 (second call uses cached) = 4
    expect(h.calls).toHaveLength(4);
    expect(new Headers(h.calls[3]!.init?.headers).get('authorization')).toBe('Bearer cached-token');
  });

  it('handles a Basic challenge by retrying with credentials', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="reg.io"' },
        });
      }
      return manifestRes([]);
    });
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'basic', username: 'u', password: 'p' },
    });
    await c.getManifest({ reference: 'v1' });
    expect(h.calls).toHaveLength(2);
    expect(new Headers(h.calls[1]!.init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
  });

  it('fails when Bearer challenge has no realm', async () => {
    const h = harness(
      () =>
        new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer service="x"' },
        }),
    );
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.getManifest({ reference: 'v1' })).rejects.toThrow(/missing realm/);
  });

  it('fails when token endpoint returns no token', async () => {
    const h = harness((url) => {
      if (url.startsWith('https://auth.x/token')) return jsonRes({});
      return new Response('', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.x/token"' },
      });
    });
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      retryAttempts: 1,
    });
    await expect(c.getManifest({ reference: 'v1' })).rejects.toThrow(/no token/);
  });

  it('throws OciRegistryError when token exchange itself fails', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.x/token"' },
        });
      }
      return new Response('forbidden', { status: 403 });
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.getManifest({ reference: 'v1' })).rejects.toThrow(/Token exchange failed/);
  });

  it('falls back to fetching without a token when Basic challenge has no credentials', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="reg.io"' },
        });
      }
      return manifestRes([]);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    // No retry since we have no basic creds — 401 bubbles up
    await expect(c.getManifest({ reference: 'v1' })).rejects.toThrow(/401/);
  });
});

describe('OciRegistryClient redirects', () => {
  it('follows same-host redirects keeping Authorization', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://reg.io/v2/foo/bar/blobs/sha256:final' },
        });
      }
      return new Response(Buffer.from('data'), { status: 200 });
    });
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'basic', username: 'u', password: 'p' },
    });
    const buf = await c.fetchBlob({ digest: DIGEST });
    expect(buf.toString()).toBe('data');
    expect(new Headers(h.calls[1]!.init?.headers).get('authorization')).toContain('Basic');
  });

  it('drops Authorization on cross-host redirects', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://cdn.example.com/blob.tgz' },
        });
      }
      return new Response(Buffer.from('cdn-data'), { status: 200 });
    });
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'basic', username: 'u', password: 'p' },
    });
    const buf = await c.fetchBlob({ digest: DIGEST });
    expect(buf.toString()).toBe('cdn-data');
    expect(new Headers(h.calls[1]!.init?.headers).get('authorization')).toBeNull();
  });

  it('aborts after maxRedirects hops', async () => {
    const h = harness((url) => {
      const n = Number(new URL(url).searchParams.get('n') ?? '0') + 1;
      return new Response(null, {
        status: 307,
        headers: { Location: `https://reg.io/v2/foo/bar/blobs/sha256:x?n=${n}` },
      });
    });
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      maxRedirects: 2,
    });
    await expect(c.fetchBlob({ digest: DIGEST })).rejects.toThrow(/Too many redirects/);
  });

  it('stops following when Location header is missing', async () => {
    const h = harness(
      () =>
        new Response('', {
          status: 307,
          // no Location header
        }),
    );
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(c.fetchBlob({ digest: DIGEST })).rejects.toThrow(OciRegistryError);
  });
});

describe('OciRegistryClient retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function runDraining<T>(p: Promise<T>): Promise<T> {
    let settled = false;
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

  it('retries on 503 then succeeds', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) return new Response('busy', { status: 503 });
      return manifestRes([]);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await runDraining(c.getManifest({ reference: 'v1' }));
    expect(h.calls).toHaveLength(2);
  });

  it('does not retry on 404', async () => {
    const h = harness(() => new Response('not found', { status: 404 }));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(runDraining(c.getManifest({ reference: 'v1' }))).rejects.toThrow(/404/);
    expect(h.calls).toHaveLength(1);
  });

  it('gives up after retryAttempts on persistent 503', async () => {
    const h = harness(() => new Response('busy', { status: 503 }));
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      retryAttempts: 2,
    });
    await expect(runDraining(c.getManifest({ reference: 'v1' }))).rejects.toThrow(/503/);
    expect(h.calls).toHaveLength(2);
  });

  it('retries on thrown network errors', async () => {
    let step = 0;
    const h = harness(() => {
      step++;
      if (step === 1) throw new Error('ECONNRESET');
      return manifestRes([]);
    });
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await runDraining(c.getManifest({ reference: 'v1' }));
    expect(h.calls).toHaveLength(2);
  });

  it('exposes status and url on OciRegistryError', async () => {
    const h = harness(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    try {
      await runDraining(c.getManifest({ reference: 'v1' }));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OciRegistryError);
      const e = err as OciRegistryError;
      expect(e.status).toBe(404);
      expect(e.url).toBe(MANIFEST_URL('v1'));
      expect(e.responseBody).toBe('nope');
    }
  });
});

describe('OciRegistryClient blob downloads', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-blob-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads a blob streamed to disk', async () => {
    const payload = Buffer.from('hello blob');
    const h = harness(() => new Response(payload, { status: 200 }));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    const target = path.join(tmpDir, 'out.bin');
    await c.downloadBlob({ digest: DIGEST, targetPath: target });
    expect(fs.readFileSync(target).toString()).toBe('hello blob');
    expect(h.calls[0]!.url).toBe(BLOB_URL(DIGEST));
  });

  it('verifies expectedSize and removes file on mismatch', async () => {
    const payload = Buffer.from('xxx');
    const h = harness(() => new Response(payload, { status: 200 }));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    const target = path.join(tmpDir, 'out.bin');
    await expect(
      c.downloadBlob({ digest: DIGEST, targetPath: target, expectedSize: 999 }),
    ).rejects.toThrow(/size mismatch/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('throws when response body is empty', async () => {
    const h = harness(() => new Response(null, { status: 200 }));
    const c = new OciRegistryClient({ registry: REG, repository: REPO, fetch: h.fetch });
    await expect(
      c.downloadBlob({ digest: DIGEST, targetPath: path.join(tmpDir, 'x') }),
    ).rejects.toThrow(/Empty response body/);
  });
});

describe('OciRegistryClient with dockerConfig auth', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-dc-client-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads credentials from a docker config file', async () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        auths: { 'reg.io': { auth: Buffer.from('docker-user:docker-pw').toString('base64') } },
      }),
    );
    const h = harness(() => manifestRes([]));
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'dockerConfig', configPath: cfg },
    });
    await c.getManifest({ reference: 'v1' });
    const authHeader = new Headers(h.calls[0]!.init?.headers).get('authorization');
    expect(authHeader).toBe(`Basic ${Buffer.from('docker-user:docker-pw').toString('base64')}`);
  });

  it('proceeds without auth when dockerConfig has no matching entry', async () => {
    const cfg = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ auths: { 'other.io': { auth: 'eA==' } } }));
    const h = harness(() => manifestRes([]));
    const c = new OciRegistryClient({
      registry: REG,
      repository: REPO,
      fetch: h.fetch,
      auth: { type: 'dockerConfig', configPath: cfg },
    });
    await c.getManifest({ reference: 'v1' });
    expect(new Headers(h.calls[0]!.init?.headers).get('authorization')).toBeNull();
  });
});
