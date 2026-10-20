import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";

const base = browserUiConfig as UserConfig;

export default defineConfig({
  ...base,
  cacheDir: "node_modules/.vite-organization-surface",
  optimizeDeps: {
    ...base.optimizeDeps,
    include: [
      ...(base.optimizeDeps?.include ?? []),
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
    ],
  },
  server: { ...base.server, port: 5215 },
});
