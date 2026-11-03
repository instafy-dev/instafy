import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import baseConfig from "../../../vite.ci-ui.config";
const base = baseConfig as UserConfig;
const adapter = "/tests/fixtures/context-hierarchy/adapters.tsx";
const sidebarAdapter = "/tests/fixtures/context-hierarchy/sidebar-adapters.tsx";
const stubs: Record<string, string> = {
  "virtual:instafy/frontend-feature-manifest": "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];",
  "/src/lib/supabaseClient.ts":
    'export const hasSupabaseConfig = false; export const supabaseUrl = undefined; export const supabaseAnonKey = undefined; export const supabase = new Proxy({}, { get() { throw new Error("No auth or storage transport in this preview"); } });',
  "/src/projects/useProject.ts": `export { useProject } from "${adapter}";`,
  "/src/providers/AuthProvider.tsx": `export { useAuth } from "${adapter}";`,
  "/src/conversations/ConversationsProvider.tsx": `export { useConversations } from "${adapter}";`,
  "/src/workspace/WorkspaceTabsProvider.tsx": `export { useWorkspaceTabs } from "${adapter}";`,
  "/src/workspace/WorkspaceAvailabilityProvider.tsx": `export { useWorkspaceAvailability } from "${adapter}";`,
  "/src/workspace/useWorkspace.tsx": `export { useWorkspaceUi } from "${adapter}";`,
  "/src/status/useStatus.ts": `export { useStatus } from "${adapter}";`,
  "/src/sdk/instafy.ts": `export * from "@instafy/sdk/capabilities"; export * from "@instafy/sdk/controller-client"; export { controllerClient, runtimeControllerEnabled } from "${sidebarAdapter}"; export const readControllerError = async () => "This is a local visual preview."; export const controllerBaseUrl = null; export const resolveControllerAccessToken = async () => null; export const resolveControllerRequestContext = async () => null;`,
  "/src/projects/useProjects.ts": `export { useProjects } from "${sidebarAdapter}";`,
  "/src/projects/useMergedControllerProjects.ts": `export { mergeControllerProjects } from "/src/projects/useMergedControllerProjects.ts?review-original"; export { useMergedControllerProjects } from "${sidebarAdapter}";`,
  "/src/profile/ProfileProvider.tsx": `export { useProfile } from "${sidebarAdapter}";`,
  "/src/runtime/useRuntimeMenu.ts": `export { useRuntimeMenuOptions } from "${sidebarAdapter}";`,
  "/src/debug/useAppLogs.ts": `export { useAppLogs } from "${sidebarAdapter}";`,
  "/src/updates/useAppUpdateMetadata.ts": `export { useAppUpdateMetadata } from "${sidebarAdapter}";`,
  "/src/updates/useDesktopReleaseLookup.ts": `export { useDesktopReleaseLookup } from "${sidebarAdapter}";`,
  "/src/screens/studio/components/DesktopChangesLine.tsx":
    "export const DesktopChangesLine = () => null;",
};
export default defineConfig({
  ...base,
  cacheDir: "node_modules/.vite-context-hierarchy",
  server: { ...base.server, port: 5368 },
  optimizeDeps: {
    ...base.optimizeDeps,
    include: [
      ...(base.optimizeDeps?.include ?? []),
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
    ],
  },
  plugins: [
    ...(base.plugins ?? []),
    {
      name: "context-hierarchy-data",
      enforce: "pre",
      resolveId(source, importer) {
        const resolved =
          source.startsWith(".") && importer
            ? path.resolve(path.dirname(importer), source)
            : source;
        for (const suffix of Object.keys(stubs))
          if (
            resolved.endsWith(suffix) ||
            resolved.endsWith(suffix.replace(/\.(tsx?|jsx?)$/, ""))
          )
            return "\0context-review:" + suffix;
      },
      load(id) {
        const prefix = "\0context-review:";
        return id.startsWith(prefix) ? stubs[id.slice(prefix.length)] : null;
      },
    },
  ],
});
