const adapter = "/tests/fixtures/workspace-surfaces/adapters.ts";
const exportsFrom = (names: string) => `export { ${names} } from ${JSON.stringify(adapter)};`;

/** Data boundaries only. Every visible panel, row, menu and dialog is production code. */
export const WORKSPACE_SURFACE_STUBS: Record<string, string> = {
  "/src/assistants/localBuiltInAssistantCatalog.ts": RUN_STOP_FIXTURE_STUBS["/src/assistants/localBuiltInAssistantCatalog.ts"],
  "virtual:instafy/frontend-feature-manifest": "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];",
  "/src/lib/supabaseClient.ts": `export const hasSupabaseConfig = false; export const supabase = new Proxy({}, { get() { throw new Error("No storage transport in this local UI review"); } });`,
  "/src/projects/useProject.ts": exportsFrom("useProject"),
  "/src/projects/useProjects.ts": exportsFrom("useProjects"),
  "/src/runtime/useRuntime.ts": exportsFrom("useRuntime"),
  "/src/runtime/useRuntimeMenu.ts": exportsFrom("useRuntimeMenuOptions"),
  "/src/runtime/runtimeResourceHistory.ts": exportsFrom("getRuntimeResourceHistory"),
  "/src/workspace/useActiveWorkspaceVersioning.ts": exportsFrom("useActiveWorkspaceVersioning"),
  "/src/workspace/WorkspaceAvailabilityProvider.tsx": exportsFrom("useWorkspaceAvailability"),
  "/src/conversations/useConversation.ts": exportsFrom("useConversation"),
  "/src/conversations/ConversationsProvider.tsx": exportsFrom("useConversations"),
  "/src/status/useStatus.ts": exportsFrom("useStatus"),
  "/src/workspace/WorkspaceTabsProvider.tsx": exportsFrom("useWorkspaceTabs"),
  "/src/services/runtimeController/agents.ts": exportsFrom("listMyAgents, updateMyAgent, getPublicAgentProfile"),
  "/src/providers/AuthProvider.tsx": exportsFrom("useAuth"),
  "/src/sdk/instafy.ts": exportsFrom("controllerClient"),
  "/src/code/useCode.ts": `export { useCode, useCodeUpdater } from "/tests/fixtures/workspace-surfaces/filesAdapters.ts";`,
  "/src/screens/studio/components/editorInlineCompletions.ts": `export const registerProxyInlineCompletionProviders = () => () => {};`,
};
import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";
