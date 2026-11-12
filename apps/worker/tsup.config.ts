import { defineConfig } from "tsup";

/**
 * The apps are bundled, not just transpiled: the workspace packages are
 * TypeScript source, so bundling keeps `node dist/x.js` self-contained while
 * node_modules stays external (native modules and pino transports must not be
 * inlined).
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  skipNodeModulesBundle: true,
  noExternal: [/^@qansa\//, "shopee-integration"],
});
