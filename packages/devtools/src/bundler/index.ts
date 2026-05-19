/**
 * Minimal bundler plugin interface compatible with Rollup, Rolldown, and Vite.
 */
export interface BundlerPlugin {
  name: string;
  resolveId?(id: string): string | undefined | null;
  load?(id: string): string | undefined | null;
}

/**
 * Rollup/Rolldown/Vite plugin that replaces `@xplane/core` and `constructs` imports
 * with references to the VM sandbox globals.
 *
 * This produces a lightweight bundle that still uses `import { Composition, Resource }
 * from '@xplane/core'` in source but resolves them to the sandbox-injected globals
 * at build time — no copy of `@xplane/core` is included in the output.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'tsdown';
 * import { vmGlobals } from '@xplane/devtools/bundler';
 *
 * export default defineConfig({
 *   entry: ['src/index.ts'],
 *   format: 'cjs',
 *   plugins: [vmGlobals()],
 * });
 * ```
 */
export function vmGlobals(): BundlerPlugin {
  return {
    name: 'xplane-vm-globals',
    resolveId(id) {
      if (id === '@xplane/core' || id === 'constructs') return `\0${id}`;
    },
    load(id) {
      if (id === '\0@xplane/core')
        return 'export const Composition = globalThis.Composition; export const Resource = globalThis.Resource; export const Construct = globalThis.Construct;';
      if (id === '\0constructs') return 'export const Construct = globalThis.Construct;';
    },
  };
}
