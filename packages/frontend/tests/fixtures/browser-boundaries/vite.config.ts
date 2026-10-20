import path from "node:path";
import { readFile } from "node:fs/promises";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";

const base = browserUiConfig as UserConfig;
const baseline = process.env.INSTAFY_BROWSER_BOUNDARIES_BASELINE_DIR;
const reviewedFiles = [
  "/src/screens/studio/components/BrowserSessionModal.tsx",
  "/src/screens/studio/components/BrowserChromeShell.tsx",
  "/src/workspace/ConversationSurfaceLayout.tsx",
];
const controller = `
  const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  export const controllerClient = {
    core: { enabled: true, baseUrl: "" },
    runtimes: {
      fetchStatus: async () => ({ runtimes: [{
        runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle",
        origin: { originId: "review-origin", endpoint: "https://fixture.example.test", protocols: ["http"] },
      }] }),
      ensure: async () => { throw new Error("Runtime allocation disabled in this review"); },
    },
    browserProfiles: { fetchStatus: async () => ({ success: true, status: { enabled: false } }) },
  };
`;

// The real UI is mounted against inert controller/transport boundaries. No env
// files, auth state, remote browser or runtime are needed for this visual review.
export default defineConfig({
  ...base,
  cacheDir: baseline ? "node_modules/.vite-browser-boundaries-before" : "node_modules/.vite-browser-boundaries",
  define: { __BROWSER_BOUNDARIES_BASELINE__: Boolean(baseline) },
  plugins: [...(base.plugins ?? []), {
    name: "browser-boundaries-review",
    enforce: "pre",
    resolveId(source, importer) {
      const resolved = source.startsWith(".") && importer ? path.resolve(path.dirname(importer), source) : source;
      if (/\/src\/sdk\/instafy(?:\/index)?(?:\.ts)?$/.test(resolved)) return "\0browser-boundaries:controller";
      if (/\/src\/services\/runtimeController\/origins(?:\.ts)?$/.test(resolved)) return "\0browser-boundaries:origin";
    },
    async load(id) {
      if (id === "\0browser-boundaries:controller") return controller;
      if (id === "\0browser-boundaries:origin") return `export async function requestOriginAccessToken() { throw new Error("No remote transport in this review"); }`;
      if (baseline && reviewedFiles.some(suffix => id.endsWith(suffix))) {
        return readFile(path.join(baseline, path.basename(id)), "utf8");
      }
    },
  }],
  server: { ...base.server, port: 5217 },
});
