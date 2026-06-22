/**
 * OCI Distribution Spec types — only the subset we actually consume.
 * See https://github.com/opencontainers/distribution-spec/blob/main/spec.md
 */

export interface ManifestLayer {
  mediaType: string;
  size: number;
  digest: string;
  annotations?: Record<string, string>;
}

export interface Manifest {
  schemaVersion: number;
  mediaType?: string;
  config?: { mediaType: string; size: number; digest: string };
  layers?: ManifestLayer[];
}

export interface IndexManifestDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations?: Record<string, string>;
}

export interface IndexManifest {
  schemaVersion: number;
  mediaType?: string;
  manifests?: IndexManifestDescriptor[];
}

export type OciAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'dockerConfig'; configPath: string };

export interface OciClientOptions {
  registry: string;
  repository: string;
  auth?: OciAuth;
  userAgent?: string;
  /** Override for testing. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Maximum retry attempts on transient failures. Default 3. */
  retryAttempts?: number;
  /** Base delay (ms) for exponential backoff between retries. Default 250. */
  retryBaseDelayMs?: number;
  /** Maximum redirect hops to follow. Default 5. */
  maxRedirects?: number;
}

export interface GetManifestOptions {
  reference: string;
  /**
   * When the registry returns an OCI image index (multi-arch),
   * select the descriptor matching this `os/arch` and re-fetch.
   * If omitted and the registry returns an index, the call throws.
   */
  platform?: string;
  /** Override Accept header set. */
  accept?: string[];
}

export interface DownloadBlobOptions {
  digest: string;
  /** Absolute path. Written atomically via `<path>.tmp-<pid>` + rename. */
  targetPath: string;
  /** When provided, the downloaded size must match exactly. */
  expectedSize?: number;
}

export interface FetchBlobOptions {
  digest: string;
}

export class OciRegistryError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBody: string | undefined;

  constructor(message: string, opts: { status: number; url: string; responseBody?: string }) {
    super(message);
    this.name = 'OciRegistryError';
    this.status = opts.status;
    this.url = opts.url;
    this.responseBody = opts.responseBody;
  }
}
