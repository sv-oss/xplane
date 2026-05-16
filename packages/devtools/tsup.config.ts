import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/assertions/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
});
