import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The same single source the build bundles (tsup.config.ts).
      "virtual:instafy/link-only-sites": fileURLToPath(
        new URL("../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.ts"],
  },
});
