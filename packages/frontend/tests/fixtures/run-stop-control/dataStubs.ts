/** Inert data boundaries only: Stop, composer editor/actions, status, rail, menus and styles are production code. */
export const RUN_STOP_FIXTURE_STUBS: Record<string, string> = {
  "/src/features/applicationFrontendFeatureComposition.ts": `
    import { createFrontendFeatureComposition } from "/src/features/frontendFeatureModule.ts";
    export const APPLICATION_FRONTEND_FEATURES = createFrontendFeatureComposition([]);
    export const APPLICATION_FRONTEND_REGISTRATION_INPUTS = {
      capabilityProviders: [], capabilityProviderRegistry: new Map(), capabilityDefinitions: [],
      capabilityExecutorProviders: [], capabilityExecutorProviderRegistry: new Map(), nativeExtensionRegistrations: {},
    };
  `,
  "/src/lib/supabaseClient.ts": `
    export const hasSupabaseConfig = false;
    export const supabase = new Proxy({}, { get() { throw new Error("Storage is disabled in this playground"); } });
  `,
  "/src/screens/studio/components/ComposerInviteModal.tsx": "export const ComposerInviteModal = () => null;",
  "/src/services/runtimeController/conversationStop.ts": `export const stopConversationJobs = async () => { throw new Error("Use the playground's injected cancel transport"); };`,
  "/src/services/runtimeController/jobs.ts": `
    export const cancelAgentJob = async () => { throw new Error("The playground must use its injected cancel transport"); };
    export const cancelPlanGroup = cancelAgentJob;
    export const fetchPlanGroupStatus = async () => { throw new Error("Historical workstream lookups are disabled in this playground"); };
  `,
  "/src/screens/studio/components/ChatCredentialRequestEntries.tsx": `
    export const IntegrationRequestEntry = () => null;
    export const SecretRequestEntry = () => null;
  `,
  "/src/status/useStatus.tsx": "export const useStatus = () => ({ showStatus() {} });",
  "/src/conversations/ConversationsProvider.tsx": `
    export const useConversations = () => { throw new Error("The playground must not load live conversations"); };
  `,
  "/src/conversations/useConversation.tsx": `
    export const useConversation = () => { throw new Error("The playground must not load conversation history"); };
  `,
  "/src/runtime/useRuntime.tsx": `
    export const useRuntime = () => { throw new Error("The playground must not connect to a runtime"); };
  `,
  "/src/store.ts": `
    export const useWorkspaceStore = () => { throw new Error("The playground must not load workspace state"); };
  `,
  "/src/providers/AuthProvider.tsx": `
    export const useAuth = () => { throw new Error("The playground must not load an account"); };
  `,
  "/src/workspace/WorkspaceTabsProvider.tsx": `
    export const useWorkspaceTabs = () => ({ openConversationTab() {}, openPanelTab() {}, requestUrlPush() {} });
  `,
  "/src/capabilities/localCapabilityArtifactRegistry.ts": "export const resolveLocalCapabilityArtifact = () => null;",
  "/src/assistants/localBuiltInAssistantCatalog.ts": `
    export const getDefaultAssistantHandle = () => "octo";
    export const getDefaultAssistantMentionToken = () => "@octo";
    export const getBuiltInAssistantDisplayName = handle => handle === "octo" ? "Octo" : handle === "scribe" ? "Scribe" : null;
    export const listBuiltInAssistantHandles = () => ["octo", "scribe"];
    export const listBuiltInAssistantMentionTokens = () => ["@octo", "@scribe"];
    export const getBuiltInAssistantMentionPatternSource = () => "@(?:octo|scribe)";
    export const resolveBuiltInAssistantMentionToken = token => token.toLowerCase();
    export const normalizeAgentHandle = handle => handle?.replace(/^@/, "").toLowerCase() ?? null;
    export const resolveBuiltInAssistantHandle = handle => listBuiltInAssistantHandles().includes(normalizeAgentHandle(handle)) ? normalizeAgentHandle(handle) : null;
    export const normalizeCustomAgentHandle = handle => resolveBuiltInAssistantHandle(handle) ? null : normalizeAgentHandle(handle);
    export const listBuiltInAssistantDefinitions = () => listBuiltInAssistantHandles().map(handle => ({
      handle, mentionToken: "@" + handle, displayName: getBuiltInAssistantDisplayName(handle),
    }));
  `,
};
