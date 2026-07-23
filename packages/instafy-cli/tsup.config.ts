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
  noExternal: ["@instafy/provider-client", /^@instafy\/sdk(?:\/.*)?$/],
});
