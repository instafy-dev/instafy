import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";
import { WORKSPACE_SURFACE_STUBS } from "./dataStubs";

const base = browserUiConfig as UserConfig;
const require = createRequire(import.meta.url);
const monacoRoot = path.dirname(createRequire(require.resolve("@monaco-editor/react")).resolve("monaco-editor/package.json"));
/** Local-only preview. Environment loading and external data transports are disabled. */
export default defineConfig({
  ...base,
  cacheDir: "node_modules/.vite-workspace-surface-review",
  resolve: { alias: { "monaco-editor": monacoRoot } },
  optimizeDeps: { ...base.optimizeDeps, include: [...(base.optimizeDeps?.include ?? []), "react-markdown", "remark-gfm", "zustand", "use-sync-external-store/shim/with-selector"] },
  server: { ...base.server, port: 5203, strictPort: true },
  plugins: [...(base.plugins ?? []), {
    name: "workspace-surface-review-data-boundaries",
    enforce: "pre",
    resolveId(source, importer) {
      const resolved = source.startsWith(".") && importer
        ? path.resolve(path.dirname(importer), source) : source;
      for (const suffix of Object.keys(WORKSPACE_SURFACE_STUBS)) {
        if (resolved.endsWith(suffix) || resolved.endsWith(suffix.replace(/\.(tsx?|jsx?)$/, ""))) {
          return `\0workspace-surface-review:${suffix}`;
        }
      }
    },
    load(id) {
      const prefix = "\0workspace-surface-review:";
      return id.startsWith(prefix) ? WORKSPACE_SURFACE_STUBS[id.slice(prefix.length)] : null;
    },
  }],
});
