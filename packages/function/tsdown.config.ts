import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node24',
  },
  {
    entry: ['src/serve.ts'],
    format: ['esm'],
    outDir: 'bundle',
    dts: false,
    sourcemap: false,
    clean: true,
    target: 'node24',
    deps: {
      alwaysBundle: /^(?!node:)/,
    },
  },
]);
