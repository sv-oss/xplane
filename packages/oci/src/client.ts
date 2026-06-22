import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveDockerConfigAuth } from './docker-config.js';
import {
  type DownloadBlobOptions,
  type FetchBlobOptions,
  type GetManifestOptions,
  type IndexManifest,
  type Manifest,
  type OciAuth,
  type OciClientOptions,
  OciRegistryError,
} from './types.js';

const DEFAULT_MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

interface BasicCredentials {
  username: string;
  password: string;
}

/**
 * Minimal client for the OCI Distribution Spec v2.
 *
 * Handles the WWW-Authenticate handshake (Basic and Bearer), follows
 * redirects (dropping Authorization on cross-host hops), and retries
 * transient failures.
 *
 * Scope is one repository per instance — bearer tokens are cached
 * for the lifetime of the client keyed by (realm|service|scope).
 */
export class OciRegistryClient {
  readonly registry: string;
  readonly repository: string;

  private readonly _fetch: typeof fetch;
  private readonly _userAgent: string;
  private readonly _retryAttempts: number;
  private readonly _retryBaseDelayMs: number;
  private readonly _maxRedirects: number;

  private _basicAuth: BasicCredentials | undefined;
  private _staticBearer: string | undefined;
  private readonly _tokenCache = new Map<string, string>();

  constructor(opts: OciClientOptions) {
    this.registry = opts.registry;
    this.repository = opts.repository;
    this._fetch = opts.fetch ?? globalThis.fetch;
    this._userAgent = opts.userAgent ?? 'xplane-oci/0.0.0';
    this._retryAttempts = opts.retryAttempts ?? 3;
    this._retryBaseDelayMs = opts.retryBaseDelayMs ?? 250;
    this._maxRedirects = opts.maxRedirects ?? 5;

    this._initAuth(opts.auth);
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async getManifest(opts: GetManifestOptions): Promise<Manifest> {
    const accept = opts.accept ?? DEFAULT_MANIFEST_ACCEPT;
    const url = this._url('manifests', opts.reference);
    const res = await this._request(url, { headers: { Accept: accept.join(', ') } });
    const body = (await res.json()) as Manifest | IndexManifest;

    if (isManifest(body)) {
      return body;
    }

    // Index manifest — resolve to a per-platform manifest.
    const descriptors = body.manifests ?? [];
    if (descriptors.length === 0) {
      throw new Error(
        `Manifest for ${this.repository}:${opts.reference} has no layers or descriptors`,
      );
    }
    if (!opts.platform) {
      const available = descriptors
        .map((d) => `${d.platform?.os ?? '?'}/${d.platform?.architecture ?? '?'}`)
        .join(', ');
      throw new Error(
        `Registry returned an image index for ${this.repository}:${opts.reference}; ` +
          `pass a \`platform\` option (available: ${available})`,
      );
    }

    const [os, arch] = splitPlatform(opts.platform);
    const match = descriptors.find(
      (m) => m.platform?.os === os && m.platform?.architecture === arch,
    );
    if (!match) {
      const available = descriptors
        .map((d) => `${d.platform?.os ?? '?'}/${d.platform?.architecture ?? '?'}`)
        .join(', ');
      throw new Error(
        `No manifest for platform ${opts.platform} in ${this.repository}:${opts.reference}. ` +
          `Available: ${available}`,
      );
    }
    return this.getManifest({ reference: match.digest, accept: opts.accept });
  }

  async fetchBlob(opts: FetchBlobOptions): Promise<Buffer> {
    const url = this._url('blobs', opts.digest);
    const res = await this._request(url, {});
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }

  async downloadBlob(opts: DownloadBlobOptions): Promise<void> {
    const url = this._url('blobs', opts.digest);
    const res = await this._request(url, {});
    if (!res.body) {
      throw new Error(`Empty response body for blob ${opts.digest}`);
    }
    const tmp = `${opts.targetPath}.tmp-${process.pid}`;
    const out = createWriteStream(tmp);
    try {
      await pipeline(Readable.fromWeb(res.body as never), out);
      renameSync(tmp, opts.targetPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    if (opts.expectedSize !== undefined) {
      const { statSync } = await import('node:fs');
      const actual = statSync(opts.targetPath).size;
      if (actual !== opts.expectedSize) {
        rmSync(opts.targetPath, { force: true });
        throw new Error(
          `Downloaded blob size mismatch for ${opts.digest}: expected ${opts.expectedSize}, got ${actual}`,
        );
      }
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private _initAuth(auth: OciAuth | undefined): void {
    if (!auth) return;
    switch (auth.type) {
      case 'basic':
        this._basicAuth = { username: auth.username, password: auth.password };
        return;
      case 'bearer':
        this._staticBearer = auth.token;
        return;
      case 'dockerConfig': {
        const creds = resolveDockerConfigAuth(auth.configPath, this.registry);
        if (creds) this._basicAuth = creds;
        return;
      }
    }
  }

  private _url(kind: 'manifests' | 'blobs', ref: string): string {
    return `https://${this.registry}/v2/${this.repository}/${kind}/${ref}`;
  }

  /**
   * Execute a request with auth challenge handling, redirect chasing, and
   * retries. Returns a successful Response (2xx); throws OciRegistryError
   * for non-2xx after exhausting retries/challenges.
   */
  private async _request(initialUrl: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this._retryAttempts; attempt++) {
      try {
        const res = await this._requestOnce(initialUrl, init);
        if (res.ok) return res;
        if (!RETRYABLE_STATUS.has(res.status) || attempt === this._retryAttempts) {
          const body = await safeReadBody(res);
          throw new OciRegistryError(
            `OCI request failed: ${res.status} ${res.statusText} (${initialUrl})`,
            { status: res.status, url: initialUrl, responseBody: body },
          );
        }
        lastErr = new OciRegistryError(`Transient ${res.status} ${res.statusText}`, {
          status: res.status,
          url: initialUrl,
        });
      } catch (err) {
        if (err instanceof OciRegistryError && !RETRYABLE_STATUS.has(err.status)) throw err;
        lastErr = err;
        if (attempt === this._retryAttempts) throw err;
      }
      const delay = this._retryBaseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
    throw lastErr ?? new Error('OCI request failed');
  }

  private async _requestOnce(initialUrl: string, init: RequestInit): Promise<Response> {
    let url = initialUrl;
    let headers = this._buildHeaders(init.headers);

    let res = await this._fetch(url, { ...init, headers, redirect: 'manual' });

    // Handle 401 challenge once.
    if (res.status === 401) {
      const challenge = res.headers.get('www-authenticate');
      if (challenge) {
        const newAuth = await this._handleChallenge(challenge);
        if (newAuth) {
          headers = this._buildHeaders(init.headers, newAuth);
          res = await this._fetch(url, { ...init, headers, redirect: 'manual' });
        }
      }
    }

    // Follow redirects manually, dropping Authorization on cross-host hops.
    let hops = 0;
    while (isRedirect(res.status)) {
      if (hops >= this._maxRedirects) {
        throw new OciRegistryError(`Too many redirects (${hops})`, {
          status: res.status,
          url,
        });
      }
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, url);
      const sameHost = next.host === new URL(url).host;
      const nextHeaders = this._buildHeaders(init.headers, sameHost ? undefined : 'drop');
      url = next.toString();
      res = await this._fetch(url, { ...init, headers: nextHeaders, redirect: 'manual' });
      hops++;
    }

    return res;
  }

  private _buildHeaders(extra: HeadersInit | undefined, override?: string | 'drop'): Headers {
    const h = new Headers(extra);
    h.set('User-Agent', this._userAgent);
    if (override === 'drop') {
      h.delete('Authorization');
      return h;
    }
    const authValue = override ?? this._authHeader();
    if (authValue) h.set('Authorization', authValue);
    return h;
  }

  private _authHeader(): string | undefined {
    if (this._staticBearer) return `Bearer ${this._staticBearer}`;
    // Token cache check: prefer a cached bearer if one exists for any scope.
    // (We don't know the scope until the challenge, so this is set after
    // _handleChallenge succeeds and is consulted on subsequent calls.)
    for (const token of this._tokenCache.values()) {
      return `Bearer ${token}`;
    }
    if (this._basicAuth) {
      const b64 = Buffer.from(`${this._basicAuth.username}:${this._basicAuth.password}`).toString(
        'base64',
      );
      return `Basic ${b64}`;
    }
    return undefined;
  }

  private async _handleChallenge(challenge: string): Promise<string | undefined> {
    const { scheme, params } = parseChallenge(challenge);
    if (scheme === 'basic') {
      if (!this._basicAuth) return undefined;
      const b64 = Buffer.from(`${this._basicAuth.username}:${this._basicAuth.password}`).toString(
        'base64',
      );
      return `Basic ${b64}`;
    }
    if (scheme === 'bearer') {
      if (!params.realm) {
        throw new Error(`Bearer challenge missing realm: ${challenge}`);
      }
      const cacheKey = `${params.realm}|${params.service ?? ''}|${params.scope ?? ''}`;
      let token = this._tokenCache.get(cacheKey);
      if (!token) {
        token = await this._acquireToken(params);
        this._tokenCache.set(cacheKey, token);
      }
      return `Bearer ${token}`;
    }
    return undefined;
  }

  private async _acquireToken(params: Record<string, string>): Promise<string> {
    const url = new URL(params.realm!);
    if (params.service) url.searchParams.set('service', params.service);
    if (params.scope) {
      for (const scope of params.scope.split(' ')) {
        if (scope) url.searchParams.append('scope', scope);
      }
    }
    if (this._basicAuth) {
      url.searchParams.set('account', this._basicAuth.username);
    }

    const headers = new Headers();
    headers.set('User-Agent', this._userAgent);
    if (this._basicAuth) {
      const b64 = Buffer.from(`${this._basicAuth.username}:${this._basicAuth.password}`).toString(
        'base64',
      );
      headers.set('Authorization', `Basic ${b64}`);
    }

    const res = await this._fetch(url.toString(), { headers });
    if (!res.ok) {
      const body = await safeReadBody(res);
      throw new OciRegistryError(
        `Token exchange failed: ${res.status} ${res.statusText} (${url})`,
        { status: res.status, url: url.toString(), responseBody: body },
      );
    }
    const json = (await res.json()) as { token?: string; access_token?: string };
    const token = json.token ?? json.access_token;
    if (!token) {
      throw new Error('Token exchange response contained no token');
    }
    return token;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isManifest(body: Manifest | IndexManifest): body is Manifest {
  return Array.isArray((body as Manifest).layers);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function splitPlatform(platform: string): [string, string] {
  const idx = platform.indexOf('/');
  if (idx === -1) {
    throw new Error(`Invalid platform "${platform}": expected os/arch`);
  }
  return [platform.slice(0, idx), platform.slice(idx + 1)];
}

function parseChallenge(value: string): { scheme: string; params: Record<string, string> } {
  const spaceIdx = value.indexOf(' ');
  const scheme = (spaceIdx === -1 ? value : value.slice(0, spaceIdx)).toLowerCase();
  const params: Record<string, string> = {};
  if (spaceIdx === -1) return { scheme, params };
  const body = value.slice(spaceIdx + 1);
  // Match key=value or key="value" pairs, separated by `,`
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g;
  for (const m of body.matchAll(re)) {
    params[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return { scheme, params };
}

async function safeReadBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 2048 ? `${text.slice(0, 2048)}…` : text;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
