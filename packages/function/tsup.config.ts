import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node24",
  },
  {
    entry: ["src/serve.ts"],
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node24",
  },
]);
