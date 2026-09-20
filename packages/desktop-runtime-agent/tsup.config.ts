import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node18",
  // tsup 8 rewrites `node:fs` to `fs` by default (`removeNodeProtocol`, slated
  // to flip to false in tsup 9). Keep the prefix so the bundle stays identical
  // to what tsup 7 built; this agent is staged into the Desktop app and run
  // from a directory we do not control.
  removeNodeProtocol: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: {
    entry: ["src/index.ts"],
  },
});
