/** Only optional composition and workspace I/O are inert; feedback and recovery owners are real. */
export const statusFeedbackBoundaries: Record<string, string> = {
  "virtual:instafy/frontend-feature-manifest": "export const APPLICATION_FRONTEND_FEATURE_MODULES = [];",
  "/src/assistants/localBuiltInAssistantCatalog.ts": `
    export const getDefaultAssistantHandle = () => "octo";
    export const resolveBuiltInAssistantHandle = handle => handle;
    export const normalizeCustomAgentHandle = handle => handle;
    export const normalizeAgentHandle = handle => handle;
    export const getBuiltInAssistantDefinition = () => null;
    export const getBuiltInAssistantDisplayName = () => "Octo";
  `,
  "/src/services/runtimeController/workspaceAvailabilityProbe.ts":
    "export async function probeWorkspaceAvailability() { return window.__reviewProbe(); }",
};
