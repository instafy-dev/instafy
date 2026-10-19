import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";
import { WORKSPACE_SURFACE_STUBS } from "../workspace-surfaces/dataStubs";

const base = browserUiConfig as UserConfig;
const adapter = "/tests/fixtures/dialogs-feedback/adapters.ts";
const fromAdapter = (names: string) => `export { ${names} } from ${JSON.stringify(adapter)};`;
const stubs: Record<string, string> = {
  ...WORKSPACE_SURFACE_STUBS,
  "/src/sdk/instafy.ts": fromAdapter("controllerClient"),
  "/src/providers/AuthProvider.tsx": fromAdapter("useAuth"),
  "/src/status/useStatus.ts": fromAdapter("useStatus"),
  "/src/projects/useProjects.ts": fromAdapter("useProjects"),
  "/src/screens/studio/workspaceControls.tsx": fromAdapter("useWorkspaceControls"),
  "/src/org/useOrgInvitations.ts": fromAdapter("useOrgInvitations"),
  "/src/org/useOrgInviteLinks.ts": fromAdapter("useOrgInviteLinks"),
  "/src/runtime/runtimeMenuShared.ts": fromAdapter("writeClipboardText"),
  "/src/sharing/nearbyInviteShare.ts": fromAdapter("buildNearbyInviteSharePayload, canUseNearbyInviteShare, isNearbyInviteShareDismissalError, nearbyInviteShareRequiresPreparedUrl, shareNearbyInvite"),
  "/src/utils/publicAppUrl.ts": `export const resolvePublicAppOrigin = () => "https://review.example.test"; export const resolvePublicAppUrl = path => new URL(path, resolvePublicAppOrigin()).href;`,
  "/src/lib/identityImages.ts": `export const IDENTITY_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp"; export const validateIdentityImage = () => null; export const uploadIdentityImage = async () => { throw new Error("Uploads disabled in local review"); };`,
};
const baseline = process.env.INSTAFY_REVIEW_BASELINE_SRC;
export default defineConfig({
  ...base,
  cacheDir: baseline ? "node_modules/.vite-dialogs-feedback-before" : "node_modules/.vite-dialogs-feedback",
  optimizeDeps: { ...base.optimizeDeps, include: [...(base.optimizeDeps?.include ?? []), "@tanstack/react-query", "react-markdown", "remark-gfm", "react-qr-code", "zustand"] },
  server: { ...base.server, port: 5209, fs: { ...base.server?.fs, allow: [...(base.server?.fs?.allow ?? []), ...(baseline ? [baseline] : [])] } },
  plugins: [...(base.plugins ?? []), {
    name: "dialogs-feedback-review-boundaries", enforce: "pre",
    async resolveId(source, importer) {
      const resolved = source.startsWith(".") && importer ? path.resolve(path.dirname(importer), source) : source;
      for (const suffix of Object.keys(stubs)) if (resolved.endsWith(suffix) || resolved.endsWith(suffix.replace(/\.(tsx?|jsx?)$/, ""))) return `\0dialogs-feedback:${suffix}`;
      if (baseline && resolved.includes("/src/") && !resolved.startsWith(baseline) && !resolved.includes("node_modules")) {
        const target = path.join(baseline, resolved.slice(resolved.lastIndexOf("/src/") + 5));
        return this.resolve(target, undefined, { skipSelf: true });
      }
    },
    load(id) { const prefix = "\0dialogs-feedback:"; return id.startsWith(prefix) ? stubs[id.slice(prefix.length)] : null; },
  }],
});
