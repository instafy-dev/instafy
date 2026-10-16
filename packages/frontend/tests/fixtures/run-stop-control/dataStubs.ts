/** Inert data boundaries only: Stop, composer editor/actions, status, rail, menus and styles are production code. */
export const RUN_STOP_FIXTURE_STUBS: Record<string, string> = {
  "/src/lib/supabaseClient.ts": `
    export const hasSupabaseConfig = false;
    export const supabase = new Proxy({}, { get() { throw new Error("Storage is disabled in this playground"); } });
  `,
  "/src/screens/studio/components/ChatBrowserDock.tsx": "export const ChatBrowserDock = () => null;",
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
  "/src/capabilities/localCapabilityArtifactRegistry.ts": "export const resolveLocalCapabilityArtifact = () => null;",
  "/src/assistants/localBuiltInAssistantCatalog.ts": `
    export const getDefaultAssistantHandle = () => "octo";
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
