import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { "assertions/index": "src/assertions/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
});
