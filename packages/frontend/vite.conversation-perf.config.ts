import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const fixture = path.join(root, "tests/playwright/conversation-perf/fixture");

/** Production renderer/data-path benchmark; inert fixture authority only. */
export default defineConfig({
  root: fixture,
  envDir: false,
  envPrefix: "INSTAFY_CONVERSATION_PERF_UNUSED_",
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^.*\/sdk\/instafy$/, replacement: path.join(fixture, "sdk.ts") },
      { find: /^.*\/(?:conversations\/ConversationsProvider|conversations\/useConversation|workspace\/WorkspaceTabsProvider|runtime\/useRuntime|runtime\/useRuntimeMenu|projects\/useProject|status\/useStatus)$/, replacement: path.join(fixture, "contexts.ts") },
      { find: "virtual:instafy/frontend-feature-manifest", replacement: path.join(root, "src/features/publicFrontendFeatureManifest.ts") },
    ],
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  define: {
    "import.meta.env.VITE_CONTROLLER_URL": JSON.stringify("http://127.0.0.1:5207/controller"),
    "import.meta.env.VITE_DISABLE_AUTO_RUNTIME_ENSURE": JSON.stringify("1"),
    __INSTAFY_BUILD_INFO__: JSON.stringify({ packageVersion: "performance-fixture" }),
  },
  build: { outDir: path.join(root, "test-results/conversation-perf-app"), emptyOutDir: true },
  preview: { host: "127.0.0.1", port: 5207, strictPort: true },
});
