import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/index.ts",
  },
  bundle: true,
  clean: false,
  dts: false,
  format: ["esm"],
  minify: false,
  platform: "node",
  sourcemap: false,
  splitting: false,
  target: "node18",
  // tsup 8 rewrites `node:fs` to `fs` by default (`removeNodeProtocol`, slated
  // to flip to false in tsup 9). Keep the prefix: it matches what tsup 7 built,
  // and a bare `fs` in a published CLI can be shadowed by a package of the same
  // name in the user's project, while `node:fs` cannot.
  removeNodeProtocol: false,
  noExternal: ["@instafy/provider-client", /^@instafy\/sdk(?:\/.*)?$/],
});
