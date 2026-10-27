import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// The web-research skill owns its link-only list; runtime-agent embeds the same file and Desktop bundles it. The CLI
// bundles it from there too rather than keeping a copy (test/web-read.spec.ts checks dist/cli.js carries it).
const linkOnlySitesPath = fileURLToPath(
  new URL("../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json", import.meta.url),
);

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
  noExternal: [
    "@instafy/provider-client",
    /^@instafy\/sdk(?:\/.*)?$/,
    /^@instafy\/bind\/(?:net|web)$/,
    "@instafy/browser-action-policy/redaction",
    "@instafy/browser-action-policy/linkOnly",
  ],
  esbuildOptions(options) {
    options.alias = { ...(options.alias ?? {}), "virtual:instafy/link-only-sites": linkOnlySitesPath };
  },
});
