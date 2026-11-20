import { defineConfig } from "tsup";

// one entry, built for import and require, with type declarations for both
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
});
