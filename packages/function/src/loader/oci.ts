import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '@crossplane-org/function-sdk-typescript';
import type { CompositionModule } from '@xplane/core';
import { type OciAuth, OciRegistryClient } from '@xplane/oci';
import * as tar from 'tar';
import { evaluateCompositionModule } from './sandbox.js';
import type {
  CompositionLoader,
  OciAuthConfig,
  OciInput,
  OciLoaderConfig,
  OciTagPullPolicy,
} from './types.js';

const CACHE_ROOT = '/tmp/xplane-oci-cache';
const TAG_CACHE_DIR = path.join(CACHE_ROOT, 'tags');
const TARBALL_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.oci.image.layer.v1.tar',
]);

/**
 * Loads composition code from an OCI registry artifact.
 *
 * Expects an OCI artifact (image manifest v1) with exactly one `tar+gzip`
 * layer containing the composition directory. The entry file inside the
 * tarball defaults to `index.js` and can be overridden via `spec.entryPoint`.
 *
 * Caches extracted layers on disk under `/tmp/xplane-oci-cache/` keyed by
 * layer digest. Tag references are re-resolved on every load via
 * `getManifest()` so updates to a moving tag are picked up; digest references
 * skip that round-trip.
 */
export class OciLoader implements CompositionLoader {
  readonly name = 'oci';

  async load(input: OciInput, logger?: Logger): Promise<CompositionModule> {
    const config = this._parseInput(input);
    const log = logger?.child({
      loader: this.name,
      registry: config.registry,
      repository: config.repository,
      ref: config.digest ?? config.tag,
      tagPullPolicy: config.tagPullPolicy,
    });

    log?.debug({ authType: config.auth?.type ?? 'anonymous' }, 'Building auth');
    const auth = this._buildAuth(config);

    fs.mkdirSync(CACHE_ROOT, { recursive: true });

    // IfNotPresent shortcut: if we have a tag→digest pointer and the cached
    // layer is still on disk, skip the manifest round-trip entirely.
    const tagPointerPath = this._tagPointerPath(config);
    if (tagPointerPath && config.tagPullPolicy === 'IfNotPresent') {
      const cached = this._readTagPointer(tagPointerPath);
      if (cached) {
        const cacheBase = path.join(CACHE_ROOT, this._digestToFilename(cached));
        const target = path.join(cacheBase, config.entryPoint);
        if (fs.existsSync(target)) {
          log?.debug({ digest: cached, target }, 'Tag cache hit — skipping manifest fetch');
          const code = fs.readFileSync(target, 'utf-8');
          return evaluateCompositionModule(code, target);
        }
        log?.debug(
          { digest: cached },
          'Tag pointer found but extracted layer missing — falling through to manifest fetch',
        );
      }
    }

    const client = new OciRegistryClient({
      registry: config.registry,
      repository: config.repository,
      auth,
    });

    const reference = config.digest ?? (config.tag as string);
    log?.debug('Resolving manifest');
    const manifest = await client.getManifest({ reference });
    const layers = manifest.layers ?? [];
    if (layers.length === 0) {
      throw new Error(`OciLoader: manifest has no layers (${config.repository}:${reference})`);
    }
    if (layers.length > 1) {
      throw new Error(
        `OciLoader: manifest has ${layers.length} layers; expected exactly 1 ` +
          `(${config.repository}:${reference}). Publish one composition per artifact.`,
      );
    }
    const layer = layers[0]!;
    log?.debug(
      { digest: layer.digest, size: layer.size, mediaType: layer.mediaType },
      'Layer resolved',
    );

    const cacheBase = path.join(CACHE_ROOT, this._digestToFilename(layer.digest));
    const targetPath = await this._ensureLayerOnDisk(config, layer, cacheBase, client, log);

    // Update the tag pointer after a successful resolve so future
    // IfNotPresent loads can short-circuit.
    if (tagPointerPath) {
      this._writeTagPointer(tagPointerPath, layer.digest);
    }

    log?.debug({ targetPath }, 'Evaluating composition');
    const code = fs.readFileSync(targetPath, 'utf-8');
    const mod = evaluateCompositionModule(code, targetPath);
    log?.debug('Oci composition loaded');
    return mod;
  }

  private _parseInput(input: OciInput): OciLoaderConfig {
    const spec = input.spec;
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error('OciLoader: input.spec must be an object');
    }

    const requireString = (field: string, value: unknown): string => {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`OciLoader: ${field} is required and must be a non-empty string`);
      }
      return value;
    };

    const optionalString = (field: string, value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`OciLoader: ${field} must be a non-empty string`);
      }
      return value;
    };

    const registry = requireString('registry', spec.registry);
    const repository = requireString('repository', spec.repository);
    const tag = optionalString('tag', spec.tag);
    const digest = optionalString('digest', spec.digest);
    if (!tag && !digest) {
      throw new Error('OciLoader: one of `tag` or `digest` is required');
    }
    if (digest && !digest.startsWith('sha256:')) {
      throw new Error('OciLoader: digest must start with "sha256:"');
    }

    const entryPoint = optionalString('entryPoint', spec.entryPoint) ?? 'index.js';
    const auth = this._parseAuth(spec.auth);
    const tagPullPolicy = this._parseTagPullPolicy(spec.tagPullPolicy);

    return { registry, repository, tag, digest, entryPoint, auth, tagPullPolicy };
  }

  private _parseTagPullPolicy(raw: unknown): OciTagPullPolicy {
    if (raw === undefined) return 'Always';
    if (raw !== 'Always' && raw !== 'IfNotPresent') {
      throw new Error(
        `OciLoader: tagPullPolicy must be "Always" or "IfNotPresent" (got ${String(raw)})`,
      );
    }
    return raw;
  }

  private _parseAuth(raw: unknown): OciAuthConfig | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('OciLoader: auth must be an object');
    }
    const a = raw as Record<string, unknown>;
    const type = a.type;

    switch (type) {
      case 'basic': {
        if (typeof a.usernamePath !== 'string' || typeof a.passwordPath !== 'string') {
          throw new Error('OciLoader: auth.basic requires usernamePath and passwordPath strings');
        }
        return { type: 'basic', usernamePath: a.usernamePath, passwordPath: a.passwordPath };
      }
      case 'token': {
        if (typeof a.tokenPath !== 'string') {
          throw new Error('OciLoader: auth.token requires tokenPath string');
        }
        return { type: 'token', tokenPath: a.tokenPath };
      }
      case 'dockerConfig': {
        if (typeof a.configPath !== 'string') {
          throw new Error('OciLoader: auth.dockerConfig requires configPath string');
        }
        return { type: 'dockerConfig', configPath: a.configPath };
      }
      default:
        throw new Error(
          `OciLoader: auth.type must be one of: basic, token, dockerConfig (got ${String(type)})`,
        );
    }
  }

  private _buildAuth(config: OciLoaderConfig): OciAuth | undefined {
    const auth = config.auth;
    if (!auth) return undefined;

    switch (auth.type) {
      case 'basic': {
        const username = this._readSecretFile(auth.usernamePath, 'username');
        const password = this._readSecretFile(auth.passwordPath, 'password');
        return { type: 'basic', username, password };
      }
      case 'token': {
        const token = this._readSecretFile(auth.tokenPath, 'token');
        return { type: 'bearer', token };
      }
      case 'dockerConfig': {
        if (!fs.existsSync(auth.configPath)) {
          throw new Error(`OciLoader: docker config file not found at path: ${auth.configPath}`);
        }
        return { type: 'dockerConfig', configPath: auth.configPath };
      }
    }
  }

  private _readSecretFile(filePath: string, label: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`OciLoader: ${label} file not found at path: ${filePath}`);
    }
    const value = fs.readFileSync(filePath, 'utf-8').trim();
    if (value.length === 0) {
      throw new Error(`OciLoader: ${label} file is empty: ${filePath}`);
    }
    return value;
  }

  private _digestToFilename(digest: string): string {
    // sha256:abc... → sha256-abc...  (safe for filenames on all platforms)
    return digest.replace(':', '-');
  }

  private _tagPointerPath(config: OciLoaderConfig): string | undefined {
    if (!config.tag) return undefined;
    const key = createHash('sha256')
      .update(`${config.registry}|${config.repository}|${config.tag}`)
      .digest('hex');
    return path.join(TAG_CACHE_DIR, `${key}.digest`);
  }

  private _readTagPointer(filePath: string): string | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    const value = fs.readFileSync(filePath, 'utf-8').trim();
    return value.startsWith('sha256:') ? value : undefined;
  }

  private _writeTagPointer(filePath: string, digest: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, digest);
    fs.renameSync(tmp, filePath);
  }

  private async _ensureLayerOnDisk(
    config: OciLoaderConfig,
    layer: { mediaType: string; size: number; digest: string },
    cacheBase: string,
    client: OciRegistryClient,
    log?: Logger,
  ): Promise<string> {
    if (!TARBALL_MEDIA_TYPES.has(layer.mediaType)) {
      throw new Error(
        `OciLoader: unsupported layer mediaType "${layer.mediaType}"; ` +
          'expected application/vnd.oci.image.layer.v1.tar+gzip',
      );
    }

    const target = path.join(cacheBase, config.entryPoint);
    if (fs.existsSync(target)) {
      log?.debug({ cacheBase }, 'Cache hit — reusing extracted layer');
      return target;
    }

    log?.debug({ cacheBase, size: layer.size }, 'Cache miss — fetching layer');
    const tmpTar = `${cacheBase}.tgz.dl`;
    await client.downloadBlob({
      digest: layer.digest,
      targetPath: tmpTar,
      expectedSize: layer.size,
    });

    fs.mkdirSync(cacheBase, { recursive: true });
    try {
      log?.debug('Extracting tarball');
      await tar.extract({
        file: tmpTar,
        cwd: cacheBase,
        // Refuse absolute paths and `..` segments — defense against tar-slip.
        strict: true,
        preservePaths: false,
      });
    } finally {
      fs.rmSync(tmpTar, { force: true });
    }
    if (!fs.existsSync(target)) {
      throw new Error(
        `OciLoader: entry file not found in tarball: ${config.entryPoint} ` +
          `(layer ${layer.digest})`,
      );
    }
    return target;
  }
}
