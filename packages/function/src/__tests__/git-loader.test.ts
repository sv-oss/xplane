import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitLoader } from '../loader/git.js';

// Mock isomorphic-git
vi.mock('isomorphic-git', () => ({
  default: {
    clone: vi.fn(),
    fetch: vi.fn(),
    checkout: vi.fn(),
  },
}));

vi.mock('isomorphic-git/http/node', () => ({
  default: {},
}));

import git from 'isomorphic-git';

interface GitOpts {
  dir: string;
  url?: string;
  ref?: string;
  depth?: number;
  singleBranch?: boolean;
  noCheckout?: boolean;
  filepaths?: string[];
  force?: boolean;
  onAuth?: () => { username: string; password: string };
}

describe('GitLoader', () => {
  const loader = new GitLoader();
  let tmpDir: string;

  const CACHE_ROOT = '/tmp/xplane-git-cache';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-loader-test-'));
    // Clean git cache to ensure test isolation
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('throws if spec is missing', async () => {
      await expect(loader.load({})).rejects.toThrow('input.spec must be an object');
    });

    it('throws if spec is not an object (string)', async () => {
      await expect(loader.load({ spec: 'bad' } as never)).rejects.toThrow(
        'input.spec must be an object',
      );
    });

    it('throws if spec is not an object (array)', async () => {
      await expect(loader.load({ spec: [] } as never)).rejects.toThrow(
        'input.spec must be an object',
      );
    });

    it('throws if url is missing', async () => {
      await expect(loader.load({ spec: { path: 'dist/index.js' } })).rejects.toThrow(
        'url is required',
      );
    });

    it('throws if url is empty', async () => {
      await expect(loader.load({ spec: { url: '', path: 'dist/index.js' } })).rejects.toThrow(
        'url is required',
      );
    });

    it('throws if path is missing', async () => {
      await expect(loader.load({ spec: { url: 'https://github.com/org/repo' } })).rejects.toThrow(
        'path is required',
      );
    });

    it('throws if path is empty', async () => {
      await expect(
        loader.load({ spec: { url: 'https://github.com/org/repo', path: '' } }),
      ).rejects.toThrow('path is required');
    });

    it('throws if ref is not a string', async () => {
      await expect(
        loader.load({ spec: { url: 'https://github.com/org/repo', path: 'x.js', ref: 123 } }),
      ).rejects.toThrow('ref must be a string');
    });

    it('throws if entryPoint is not a string', async () => {
      await expect(
        loader.load({
          spec: { url: 'https://github.com/org/repo', path: 'x.js', entryPoint: 42 },
        }),
      ).rejects.toThrow('entryPoint must be a string');
    });

    it('throws if tokenPath is not a string', async () => {
      await expect(
        loader.load({
          spec: { url: 'https://github.com/org/repo', path: 'x.js', tokenPath: true },
        }),
      ).rejects.toThrow('tokenPath must be a string');
    });

    it('throws if provider is invalid', async () => {
      await expect(
        loader.load({
          spec: { url: 'https://github.com/org/repo', path: 'x.js', provider: 'azure' },
        }),
      ).rejects.toThrow('provider must be one of');
    });
  });

  describe('token handling', () => {
    it('throws if tokenPath file does not exist', async () => {
      await expect(
        loader.load({
          spec: {
            url: 'https://github.com/org/repo',
            path: 'dist/index.js',
            tokenPath: '/nonexistent/token',
          },
        }),
      ).rejects.toThrow('token file not found');
    });

    it('throws if token file is empty', async () => {
      const tokenFile = path.join(tmpDir, 'token');
      fs.writeFileSync(tokenFile, '  \n');

      await expect(
        loader.load({
          spec: {
            url: 'https://github.com/org/repo',
            path: 'dist/index.js',
            tokenPath: tokenFile,
          },
        }),
      ).rejects.toThrow('token file is empty');
    });
  });

  describe('clone and checkout', () => {
    it('clones on cache miss and checks out the file', async () => {
      const tokenFile = path.join(tmpDir, 'token');
      fs.writeFileSync(tokenFile, 'ghp_abc123\n');

      // Mock checkout to write a composition file
      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'dist/composition.js');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          `class MyComp extends Composition { constructor() { super(); } }
           exports.run = (input) => runComposition(MyComp, input);`,
        );
      });

      const result = await loader.load({
        spec: {
          url: 'https://github.com/org/repo',
          path: 'dist/composition.js',
          ref: 'main',
          tokenPath: tokenFile,
          provider: 'github',
        },
      });

      expect(git.clone).toHaveBeenCalledTimes(1);
      expect(git.fetch).not.toHaveBeenCalled();
      expect(git.checkout).toHaveBeenCalledTimes(1);

      const cloneCall = vi.mocked(git.clone).mock.calls[0]![0] as GitOpts;
      expect(cloneCall.url).toBe('https://github.com/org/repo');
      expect(cloneCall.depth).toBe(1);
      expect(cloneCall.singleBranch).toBe(true);
      expect(cloneCall.noCheckout).toBe(true);
      expect(cloneCall.ref).toBe('main');

      // Verify auth callback
      expect(cloneCall.onAuth).toBeDefined();
      const auth = cloneCall.onAuth!();
      expect(auth).toEqual({ username: 'x-access-token', password: 'ghp_abc123' });

      // Verify checkout filepaths
      const checkoutCall = vi.mocked(git.checkout).mock.calls[0]![0] as GitOpts;
      expect(checkoutCall.filepaths).toEqual(['dist/composition.js']);
      expect(checkoutCall.force).toBe(true);

      expect(typeof result).toBe('object');
      expect(typeof result.run).toBe('function');
    });

    it('fetches on cache hit instead of cloning', async () => {
      // Simulate cache hit by pre-creating the cache dir
      // @ts-expect-error mock implementation uses simplified opts type
      vi.mocked(git.clone).mockImplementation(async (opts: GitOpts) => {
        // clone creates the dir
        fs.mkdirSync(opts.dir, { recursive: true });
      });

      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'src/index.js');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          `class C extends Composition { constructor() { super(); } }
           exports.run = (input) => runComposition(C, input);`,
        );
      });

      // First call — cache miss
      await loader.load({
        spec: { url: 'https://github.com/org/repo', path: 'src/index.js', ref: 'v1.0' },
      });

      vi.clearAllMocks();

      // Re-mock checkout for second call
      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'src/index.js');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          `class C extends Composition { constructor() { super(); } }
           exports.run = (input) => runComposition(C, input);`,
        );
      });

      // Second call — cache hit (dir exists)
      await loader.load({
        spec: { url: 'https://github.com/org/repo', path: 'src/index.js', ref: 'v1.0' },
      });

      expect(git.clone).not.toHaveBeenCalled();
      expect(git.fetch).toHaveBeenCalledTimes(1);
      expect(git.checkout).toHaveBeenCalledTimes(1);
    });

    it('resolves entryPoint when path is a directory', async () => {
      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'compositions/vpc/main.js');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          `class VPC extends Composition { constructor() { super(); } }
           exports.run = (input) => runComposition(VPC, input);`,
        );
      });

      const result = await loader.load({
        spec: {
          url: 'https://github.com/org/repo',
          path: 'compositions/vpc',
          entryPoint: 'main.js',
        },
      });

      expect(typeof result.run).toBe('function');

      const checkoutCall = vi.mocked(git.checkout).mock.calls[0]![0] as GitOpts;
      expect(checkoutCall.filepaths).toEqual(['compositions/vpc']);
    });

    it('defaults entryPoint to index.js for directory paths', async () => {
      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'compositions/vpc/index.js');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          `class VPC extends Composition { constructor() { super(); } }
           exports.run = (input) => runComposition(VPC, input);`,
        );
      });

      const result = await loader.load({
        spec: {
          url: 'https://github.com/org/repo',
          path: 'compositions/vpc',
        },
      });

      expect(typeof result.run).toBe('function');
    });
  });

  describe('auth provider formatting', () => {
    it.each([
      ['github', 'x-access-token', 'mytoken'],
      ['gitlab', 'oauth2', 'mytoken'],
      ['bitbucket', 'x-token-auth', 'mytoken'],
    ] as const)('formats auth correctly for %s', async (provider, expectedUser, _token) => {
      const tokenFile = path.join(tmpDir, 'token');
      fs.writeFileSync(tokenFile, 'mytoken');

      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'x.js');
        fs.writeFileSync(
          filePath,
          `class C extends Composition { constructor() { super(); } }
           exports.run = (input) => runComposition(C, input);`,
        );
      });

      await loader.load({
        spec: {
          url: `https://example.com/${provider}-repo`,
          path: 'x.js',
          tokenPath: tokenFile,
          provider,
        },
      });

      // May be a clone (cache miss) or fetch (cache hit) — check whichever was called
      const cloneCalls = vi.mocked(git.clone).mock.calls;
      const fetchCalls = vi.mocked(git.fetch).mock.calls;
      const call = (cloneCalls[0]?.[0] ?? fetchCalls[0]?.[0]) as GitOpts;
      expect(call.onAuth).toBeDefined();
      const auth = call.onAuth!();
      expect(auth.username).toBe(expectedUser);
      expect(auth.password).toBe('mytoken');
    });
  });

  describe('error handling', () => {
    it('throws if target file not found after checkout', async () => {
      vi.mocked(git.checkout).mockImplementation(async () => {
        // Don't write any file — simulates path not existing in repo
      });

      await expect(
        loader.load({ spec: { url: 'https://github.com/org/repo', path: 'nonexistent.js' } }),
      ).rejects.toThrow('target file not found after checkout');
    });

    it('throws if composition code is invalid', async () => {
      vi.mocked(git.checkout).mockImplementation(async (opts: GitOpts) => {
        const filePath = path.join(opts.dir, 'bad.js');
        fs.writeFileSync(filePath, 'const x = 1; // no export');
      });

      await expect(
        loader.load({ spec: { url: 'https://github.com/org/repo', path: 'bad.js' } }),
      ).rejects.toThrow("must export a 'run' function");
    });
  });
});
