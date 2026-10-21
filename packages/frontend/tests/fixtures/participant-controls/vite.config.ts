import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";

const base = browserUiConfig as UserConfig;

// Production controls, with no optional deployment modules or authenticated app.
export default defineConfig({
  ...base,
  cacheDir: "node_modules/.vite-participant-controls",
  plugins: [...(base.plugins ?? []), {
    name: "participant-controls-inert-features",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "virtual:instafy/frontend-feature-manifest") return "\0participant-controls:features";
      const resolved = source.startsWith(".") && importer ? path.resolve(path.dirname(importer), source) : source;
      if (/\/src\/assistants\/localBuiltInAssistantCatalog(?:\.ts)?$/.test(resolved)) return "\0participant-controls:assistants";
    },
    load(id) {
      if (id === "\0participant-controls:features") return "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];";
      if (id === "\0participant-controls:assistants") return 'export const getDefaultAssistantHandle = () => "octo"; export const resolveBuiltInAssistantHandle = handle => handle;';
    },
  }],
  server: { ...base.server, port: 5232 },
});
