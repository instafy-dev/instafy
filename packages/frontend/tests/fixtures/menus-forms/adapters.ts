// Inert in-memory boundary data; never use real credentials in this fixture.
export const showStatus = (message: string) => window.dispatchEvent(new CustomEvent("review:status", { detail: message }));
const ok = async () => ({ success: true });
const agents = ["octo", "writer", "release-review", "accessibility-review"].map((handle, index) => ({ id: `agent-${index}`, handle, displayName: handle, description: "Local review agent", avatarSeed: handle, runtimeId: null }));
let secrets = [
 { id: "secret-1", name: "DEPLOY_PREVIEW_TOKEN", description: "Used to publish isolated preview environments for this space.", agentIds: ["agent-0", "agent-1"], agentHandles: ["octo", "writer"], revokedAt: null },
 { id: "secret-2", name: "RESEARCH_API_KEY", description: "Read-only access for research and documentation.", agentIds: ["agent-1"], agentHandles: ["writer"], revokedAt: null },
];
if (new URLSearchParams(location.search).has("long")) secrets[0].name = "DEPLOY_PREVIEW_TOKEN_FOR_SHARED_REVIEW_ENVIRONMENTS";
let failSecretsRead = new URLSearchParams(location.search).has("error");
const credentials = [
 { id: "credential-1", kind: "openai_api_key", label: "Development API key", isDefault: true, metadata: { provider: "openai" }, lastUsedAt: null, revokedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
 { id: "credential-2", kind: "openai_api_key", label: "Research connection", isDefault: false, metadata: { provider: "gemini" }, lastUsedAt: null, revokedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
];
const auth = { user: { id: "review-user", email: "review@example.test" }, session: null };
export const useAuth = () => auth;
export const useStatus = () => ({ showStatus });
export const useProjects = () => ({ activeProjectId: "review-space", activeProject: { id: "review-space", name: "Product workshop" } });
export const useWorkspaceTabs = () => ({ openPanelTab: () => {}, requestUrlPush: () => {} });
export const runtimeControllerEnabled = true;
export const controllerBaseUrl = "http://127.0.0.1:1";
const unavailable = async () => ({ success: false, error: "Review only: no external connection is made." });
const credentialTestDelay = new URLSearchParams(location.search).has("slowTest") ? 5000 : 700;
export const controllerClient = {
 agents: { list: async () => ({ success: true, agents }), create: ok, remove: ok, update: ok },
 secrets: {
  listForProject: async () => { if (failSecretsRead) { failSecretsRead = false; return { success: false, error: "Local review error" }; } return { success: true, secrets }; },
  createForProject: async (_project: string, value: { name: string; description: string; agentHandles: string[] }) => { secrets = [...secrets, { id: `secret-${Date.now()}`, ...value, agentIds: [], revokedAt: null }]; showStatus("Secret created in this local review only."); return { success: true }; },
  updateForProject: ok, revokeForProject: ok,
 },
 credentials: { list: async () => ({ success: true, credentials }), getRequirements: async () => ({ success: true, requiresUserCredentials: false, proxyBackend: "codex", hasDefaultCredential: true, managedAi: { enabled: false } }), clearDefault: ok, createCodex: unavailable, createOpenAiApiKey: unavailable, createApiKey: unavailable, revoke: ok, setDefault: ok, test: async () => { await new Promise(resolve => setTimeout(resolve, credentialTestDelay)); return { success: false, error: "Review connection could not be verified. Retry with a valid key." }; }, startDeviceAuth: unavailable, cancelDeviceAuth: ok },
};
