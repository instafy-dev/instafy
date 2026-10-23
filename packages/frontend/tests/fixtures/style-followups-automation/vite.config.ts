import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
const adapter = "/tests/fixtures/style-followups-automation/adapters.ts";
const exportsFrom = (names: string) => `export { ${names} } from ${JSON.stringify(adapter)};`;
export default createStyleReviewConfig({ name: "automation", port: 5238, optimize: ["@tanstack/react-query"], stubs: {
  "/src/sdk/instafy.ts": exportsFrom("controllerClient"),
  "/src/providers/AuthProvider.tsx": exportsFrom("useAuth"),
  "/src/projects/useProjects.ts": exportsFrom("useProjects"),
  "/src/runtime/RuntimeStateProvider.tsx": exportsFrom("useRuntimeState"),
  "/src/workspace/WorkspaceTabsProvider.tsx": exportsFrom("useWorkspaceTabs"),
  "/src/lib/supabaseClient.ts": `export const hasSupabaseConfig = false; export const supabase = new Proxy({}, { get() { throw new Error("No network in local automation review"); } });`,
  "virtual:instafy/frontend-feature-manifest": "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];",
} });
