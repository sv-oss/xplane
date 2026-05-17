import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { evaluateCompositionCode } from './sandbox.js';
import type { CompositionClass, CompositionLoader, GitInput, GitLoaderConfig } from './types.js';

/** Supported git hosting providers for auth token formatting. */
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

const CACHE_ROOT = '/tmp/xplane-git-cache';

/**
 * Format auth credentials based on the git hosting provider.
 */
function formatAuth(token: string, provider: GitProvider): { username: string; password: string } {
  switch (provider) {
    case 'github':
      return { username: 'x-access-token', password: token };
    case 'gitlab':
      return { username: 'oauth2', password: token };
    case 'bitbucket':
      return { username: 'x-token-auth', password: token };
  }
}

/**
 * Compute a stable cache directory name from url and ref.
 */
function cacheDir(url: string, ref: string): string {
  const hash = createHash('sha256').update(`${url}|${ref}`).digest('hex').slice(0, 16);
  return path.join(CACHE_ROOT, hash);
}

/**
 * Loads composition code from a git repository via sparse checkout.
 *
 * Expects `input.git` to contain the repository configuration.
 * Clones with depth=1 and only checks out the specified path (file or directory).
 * Caches clones on disk under `/tmp/xplane-git-cache/` keyed by url+ref.
 * Supports auth via a token file mounted as a Kubernetes secret.
 */
export class GitLoader implements CompositionLoader {
  readonly name = 'git';

  async load(input: GitInput): Promise<CompositionClass> {
    const config = this._parseInput(input);
    const onAuth = this._buildOnAuth(config);
    const dir = cacheDir(config.url, config.ref ?? 'HEAD');

    // Ensure cache root exists
    fs.mkdirSync(CACHE_ROOT, { recursive: true });

    if (fs.existsSync(dir)) {
      // Cache hit — fetch latest
      await git.fetch({
        fs,
        http,
        dir,
        singleBranch: true,
        onAuth,
      });
    } else {
      // Cache miss — shallow clone without checkout
      await git.clone({
        fs,
        http,
        dir,
        url: config.url,
        ref: config.ref,
        singleBranch: true,
        depth: 1,
        noCheckout: true,
        onAuth,
      });
    }

    // Checkout only the requested path (file or directory)
    await git.checkout({
      fs,
      dir,
      ref: config.ref,
      filepaths: [config.path],
      force: true,
    });

    // Determine the file to evaluate
    const targetPath = this._resolveTarget(dir, config);
    if (!fs.existsSync(targetPath)) {
      throw new Error(
        `GitLoader: target file not found after checkout: ${config.path}` +
          (config.entryPoint ? `/${config.entryPoint}` : ''),
      );
    }

    const code = fs.readFileSync(targetPath, 'utf-8');
    return evaluateCompositionCode(code, targetPath);
  }

  private _parseInput(input: GitInput): GitLoaderConfig {
    const spec = input.spec;
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error('GitLoader: input.spec must be an object');
    }
    const config = spec;

    if (typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error('GitLoader: url is required and must be a non-empty string');
    }

    if (typeof config.path !== 'string' || config.path.length === 0) {
      throw new Error('GitLoader: path is required and must be a non-empty string');
    }

    if (config.ref !== undefined && typeof config.ref !== 'string') {
      throw new Error('GitLoader: ref must be a string');
    }

    if (config.entryPoint !== undefined && typeof config.entryPoint !== 'string') {
      throw new Error('GitLoader: entryPoint must be a string');
    }

    if (config.tokenPath !== undefined && typeof config.tokenPath !== 'string') {
      throw new Error('GitLoader: tokenPath must be a string');
    }

    if (config.provider !== undefined) {
      if (
        config.provider !== 'github' &&
        config.provider !== 'gitlab' &&
        config.provider !== 'bitbucket'
      ) {
        throw new Error('GitLoader: provider must be one of: github, gitlab, bitbucket');
      }
    }

    return {
      url: config.url,
      path: config.path,
      ref: config.ref as string | undefined,
      entryPoint: config.entryPoint as string | undefined,
      tokenPath: config.tokenPath as string | undefined,
      provider: (config.provider as GitProvider) ?? 'github',
    };
  }

  private _buildOnAuth(
    config: GitLoaderConfig,
  ): (() => { username: string; password: string }) | undefined {
    if (!config.tokenPath) return undefined;

    if (!fs.existsSync(config.tokenPath)) {
      throw new Error(`GitLoader: token file not found at path: ${config.tokenPath}`);
    }

    const token = fs.readFileSync(config.tokenPath, 'utf-8').trim();
    if (token.length === 0) {
      throw new Error(`GitLoader: token file is empty: ${config.tokenPath}`);
    }

    const provider = config.provider ?? 'github';
    return () => formatAuth(token, provider);
  }

  private _resolveTarget(dir: string, config: GitLoaderConfig): string {
    const fullPath = path.join(dir, config.path);

    // If path looks like a file (has a JS/TS extension), use it directly
    if (/\.(js|cjs|mjs)$/.test(config.path)) {
      return fullPath;
    }

    // Otherwise treat as directory and use entryPoint
    const entryPoint = config.entryPoint ?? 'index.js';
    return path.join(fullPath, entryPoint);
  }
}
