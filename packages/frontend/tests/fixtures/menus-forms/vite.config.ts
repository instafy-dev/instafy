import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";
import { WORKSPACE_SURFACE_STUBS } from "../workspace-surfaces/dataStubs";
const base = browserUiConfig as UserConfig;
const adapter = "/tests/fixtures/menus-forms/adapters.ts";
const fromAdapter = (names: string) => `export { ${names} } from ${JSON.stringify(adapter)};`;
const stubs = { ...WORKSPACE_SURFACE_STUBS,
 "/src/sdk/instafy.ts": fromAdapter("controllerClient, controllerBaseUrl, runtimeControllerEnabled"),
 "/src/providers/AuthProvider.tsx": fromAdapter("useAuth"),
 "/src/status/useStatus.ts": fromAdapter("useStatus"),
 "/src/projects/useProjects.ts": fromAdapter("useProjects"),
 "/src/workspace/WorkspaceTabsProvider.tsx": fromAdapter("useWorkspaceTabs"),
 "/src/lib/identityImages.ts": `export const IDENTITY_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp"; export const validateIdentityImage = () => null; export const uploadIdentityImage = async () => { throw new Error("Uploads disabled in local review"); };`,
 "/src/screens/studio/components/desktopCodexAuthJson.ts": `export const canUseDesktopCodexAuthJson = () => false; export const connectDesktopCodexAuthJson = async () => ({ success: false }); export const useDesktopCodexAuthJsonStatus = () => null; export const isLikelyDesktopDevice = () => false; export const shouldPromptForCodexAuthJsonUpload = () => false;`,
 "/src/screens/studio/components/devServerCodexAuthJson.ts": `export const canUseDevServerCodexAuthJson = () => false; export const connectDevServerCodexAuthJson = async () => ({ success: false });`,
};
// Optional read-only source snapshot supports reproducible before/after review.
const baseline = process.env.INSTAFY_REVIEW_BASELINE_SRC;
export default defineConfig({ ...base,
 cacheDir: baseline ? "node_modules/.vite-menus-forms-before" : "node_modules/.vite-menus-forms",
 optimizeDeps: { ...base.optimizeDeps, include: [...(base.optimizeDeps?.include ?? []), "@tanstack/react-query", "react-markdown", "remark-gfm", "zustand"] },
 server: { ...base.server, port: 5206, fs: { ...base.server?.fs, allow: [...(base.server?.fs?.allow ?? []), ...(baseline ? [baseline] : [])] } },
 plugins: [...(base.plugins ?? []), { name: "menus-forms-review-boundaries", enforce: "pre", async resolveId(source, importer) {
  const resolved = source.startsWith(".") && importer ? path.resolve(path.dirname(importer), source) : source;
  for (const [suffix] of Object.entries(stubs)) if (resolved.endsWith(suffix) || resolved.endsWith(suffix.replace(/\.(tsx?|jsx?)$/, ""))) return `\0menus-forms:${suffix}`;
  if (baseline && resolved.includes("/src/") && !resolved.startsWith(baseline) && !resolved.includes("node_modules")) {
   const target = path.join(baseline, resolved.slice(resolved.lastIndexOf("/src/") + 5));
   return this.resolve(target, undefined, { skipSelf: true });
  }
 }, load(id) { const prefix = "\0menus-forms:"; return id.startsWith(prefix) ? stubs[id.slice(prefix.length) as keyof typeof stubs] : null; } }],
});
