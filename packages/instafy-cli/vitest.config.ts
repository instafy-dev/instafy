import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The unit tests run the CLI's source as a test build, which answers from INSTAFY_WEB_FIXTURES (tsup.config.ts).
  define: { __INSTAFY_TEST_BUILD__: "true" },
  resolve: {
    alias: {
      // The same single source the build bundles (tsup.config.ts).
      "virtual:instafy/link-only-sites": fileURLToPath(
        new URL("../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json", import.meta.url),
      ),
      "virtual:instafy/search-providers": fileURLToPath(
        new URL("../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/search-providers.json", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.ts"],
  },
});
