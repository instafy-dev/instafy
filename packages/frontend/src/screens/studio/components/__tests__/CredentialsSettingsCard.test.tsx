// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";
import type { AgentProfileModal } from "../AgentProfileModal";

const mocks = vi.hoisted(() => ({
  clearDefaultCredential: vi.fn(),
  createCodexCredential: vi.fn(),
  createAgent: vi.fn(),
  agentProfileProps: null as ComponentProps<typeof AgentProfileModal> | null,
  deleteAgent: vi.fn(),
  getCredentialRequirements: vi.fn(),
  listAgents: vi.fn(),
  listCredentials: vi.fn(),
  revokeCredential: vi.fn(),
  setDefaultCredential: vi.fn(),
  showStatus: vi.fn(),
  testCredential: vi.fn(),
  updateAgent: vi.fn(),
}));

vi.mock("../../../../providers/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "playwright@instafy.dev" },
  }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({
    showStatus: mocks.showStatus,
  }),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "http://127.0.0.1:8789",
  runtimeControllerEnabled: true,
  controllerClient: {
    agents: {
      create: mocks.createAgent,
      list: mocks.listAgents,
      remove: mocks.deleteAgent,
      update: mocks.updateAgent,
    },
    credentials: {
      clearDefault: mocks.clearDefaultCredential,
      createCodex: mocks.createCodexCredential,
      getRequirements: mocks.getCredentialRequirements,
      list: mocks.listCredentials,
      revoke: mocks.revokeCredential,
      setDefault: mocks.setDefaultCredential,
      test: mocks.testCredential,
    },
  },
}));

vi.mock("../CredentialsConnectModal", () => ({
  CredentialsConnectModal: () => null,
}));

vi.mock("../AgentProfileModal", () => ({
  AgentProfileModal: (props: ComponentProps<typeof AgentProfileModal>) => {
    mocks.agentProfileProps = props;
    return null;
  },
}));

vi.mock("../useCredentialsConnectFlow", () => ({
  useCredentialsConnectFlow: () => ({
    canManageAiConnections: true,
    openConnectModal: vi.fn(),
    openConnectModalAtStep: vi.fn(),
    connectModalProps: {},
  }),
}));

const oldCredential = {
  id: "cred-old",
  kind: "codex_auth_json",
  label: "Browser upload",
  isDefault: true,
  metadata: { account_id: "acct_1234567890" },
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const TOKEN_EXPIRED_ERROR = `unexpected status 502 Bad Gateway: upstream request failed (credential_source=claim, endpoint=chatgpt.com/backend-api/codex/responses, requested_model=gpt-5.1-codex-max, resolved_model=gpt-5.1-codex-max): backend responded with 401 Unauthorized: {
  "error": {
    "message": "Provided authentication token is expired. Please try signing in again.",
    "type": null,
    "code": "token_expired",
    "param": null
  },
  "status": 401
}, url: http://proxy:8789/v1/responses`;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CredentialsSettingsCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mocks.clearDefaultCredential.mockReset();
    mocks.createCodexCredential.mockReset();
    mocks.createAgent.mockReset();
    mocks.agentProfileProps = null;
    mocks.deleteAgent.mockReset();
    mocks.getCredentialRequirements.mockReset();
    mocks.listAgents.mockReset();
    mocks.listCredentials.mockReset();
    mocks.revokeCredential.mockReset();
    mocks.setDefaultCredential.mockReset();
    mocks.showStatus.mockReset();
    mocks.testCredential.mockReset();
    mocks.updateAgent.mockReset();

    mocks.listCredentials.mockResolvedValue({
      success: true,
      credentials: [oldCredential],
    });
    mocks.listAgents.mockResolvedValue({
      success: true,
      agents: [],
    });
    mocks.getCredentialRequirements.mockResolvedValue({
      success: true,
      requiresUserCredentials: true,
      proxyBackend: "codex",
      hasDefaultCredential: true,
      managedAi: null,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const inheritedAgent = {
    id: "agent-1", handle: "helper", displayName: "Helper", avatarSeed: "helper",
    description: "Keep responses concise.", bio: "An introduction.", provider: "openai",
    model: null as string | null, credentialId: null, reasoningEffort: null, runtimeId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  async function renderAgent(agent = inheritedAgent) {
    mocks.listAgents.mockResolvedValue({ success: true, agents: [agent] });
    mocks.updateAgent.mockResolvedValue({ success: true, agent });
    await act(async () => { root.render(<CredentialsSettingsCard />); await flush(); });
  }
  async function openAgent(handle = "helper") {
    const selector = handle === "octo" ? "bots-octo-edit" : "bots-edit-agent-1";
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${selector}"]`)!.click());
    expect(mocks.agentProfileProps?.isOpen).toBe(true);
  }
  async function saveProfile() {
    await act(async () => { mocks.agentProfileProps!.onSave(); await flush(); });
  }

  it.each([
    ["helper", null], ["octo", null], ["helper", "custom-unlisted-model"], ["octo", "custom-unlisted-model"],
  ])("preserves inherited credentials and the saved model for a bio-only edit of %s (%s)", async (handle, model) => {
    await renderAgent({ ...inheritedAgent, handle: handle!, model });
    await openAgent(handle!);
    expect(mocks.agentProfileProps?.credentialId).toBe(oldCredential.id);
    expect(mocks.agentProfileProps?.modelId).not.toBeNull();
    await act(async () => mocks.agentProfileProps!.onBioChange!("A new public introduction."));
    await saveProfile();

    expect(mocks.updateAgent).toHaveBeenCalledOnce();
    const [id, patch] = mocks.updateAgent.mock.calls[0];
    expect(id).toBe(inheritedAgent.id);
    expect(patch.bio).toBe("A new public introduction.");
    expect(patch.description).toBe(inheritedAgent.description);
    expect(patch).not.toHaveProperty("model");
    expect(patch).not.toHaveProperty("credentialId");
  });

  it("persists an explicit model edit without pinning the displayed default credential", async () => {
    await renderAgent(); await openAgent();
    const model = mocks.agentProfileProps!.modelOptions![1].id;
    await act(async () => mocks.agentProfileProps!.onModelChange!(model));
    await saveProfile();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ model });
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("credentialId");
  });

  it("persists an explicit credential edit within one provider without replacing an inherited model", async () => {
    mocks.listCredentials.mockResolvedValue({ success: true, credentials: [oldCredential, { ...oldCredential, id: "cred-other", isDefault: false }] });
    await renderAgent(); await openAgent();
    await act(async () => mocks.agentProfileProps!.onCredentialChange!("cred-other"));
    await saveProfile();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ credentialId: "cred-other" });
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("model");
  });

  it.each(["provider", "credential"])("updates both settings when an explicit %s change switches AI provider", async (control) => {
    mocks.listCredentials.mockResolvedValue({ success: true, credentials: [oldCredential, {
      ...oldCredential, id: "cred-deepseek", isDefault: false, kind: "openai_api_key", metadata: { provider: "deepseek" },
    }] });
    await renderAgent(); await openAgent();
    await act(async () => {
      if (control === "provider") mocks.agentProfileProps!.onProviderChange!("deepseek");
      else mocks.agentProfileProps!.onCredentialChange!("cred-deepseek");
    });
    const model = mocks.agentProfileProps!.modelId;
    await saveProfile();
    expect(mocks.updateAgent.mock.lastCall?.[1]).toMatchObject({ credentialId: "cred-deepseek", model });
  });

  it("resets model and credential edits when the modal closes and reopens", async () => {
    await renderAgent(); await openAgent();
    await act(async () => {
      mocks.agentProfileProps!.onModelChange!("gpt-5.5");
      mocks.agentProfileProps!.onCredentialChange!(oldCredential.id);
    });
    await act(async () => mocks.agentProfileProps!.onClose());
    await openAgent();
    await act(async () => mocks.agentProfileProps!.onBioChange!("Only this change should save."));
    await saveProfile();
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("model");
    expect(mocks.updateAgent.mock.lastCall?.[1]).not.toHaveProperty("credentialId");
  });

  it("still sends the initial credential and model defaults when creating a bot", async () => {
    mocks.createAgent.mockResolvedValue({ success: true, agent: inheritedAgent });
    await renderAgent();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="bots-create"]')!.click());
    expect(mocks.agentProfileProps!.mode).toBe("create");
    const model = mocks.agentProfileProps!.modelId;
    await saveProfile();
    expect(mocks.createAgent.mock.lastCall?.[0]).toMatchObject({ credentialId: oldCredential.id, model });
    expect(mocks.updateAgent).not.toHaveBeenCalled();
  });

  it("shows failed auth.json test feedback and an explicit reconnect action", async () => {
    mocks.testCredential.mockResolvedValue({
      success: false,
      error: "401 Unauthorized: session expired",
    });

    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });

    expect(container.textContent).toContain("Browser upload");
    expect(container.textContent).toContain("Default");
    expect(container.querySelector('[data-testid="credentials-connection-reconnect-cred-old"]')).not.toBeNull();

    const testButton = container.querySelector(
      '[data-testid="credentials-connection-test-cred-old"]',
    ) as HTMLButtonElement | null;
    expect(testButton).not.toBeNull();

    await act(async () => {
      testButton?.click();
      await flush();
    });

    expect(mocks.testCredential).toHaveBeenCalledWith("cred-old");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("401 Unauthorized: session expired");
    expect(container.textContent).not.toContain("Needs reconnect");
  });

  it("shows needs-reconnect feedback for structured expired ChatGPT credentials", async () => {
    mocks.testCredential.mockResolvedValue({
      success: false,
      error: TOKEN_EXPIRED_ERROR,
    });

    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });

    const testButton = container.querySelector(
      '[data-testid="credentials-connection-test-cred-old"]',
    ) as HTMLButtonElement | null;
    expect(testButton).not.toBeNull();

    await act(async () => {
      testButton?.click();
      await flush();
    });

    expect(mocks.testCredential).toHaveBeenCalledWith("cred-old");
    expect(container.textContent).toContain("Needs reconnect");
    expect(container.textContent).toContain("The saved AI login is stale. Reconnect it below, then test again.");
    expect(container.querySelector('[data-testid="credentials-connection-reconnect-cred-old"]')).not.toBeNull();
  });

  it("reconnects browser-upload auth.json without deleting the old row first", async () => {
    mocks.createCodexCredential.mockResolvedValue({
      success: true,
      credentialId: "cred-new",
      kind: "codex_auth_json",
      isDefault: true,
    });
    mocks.revokeCredential.mockResolvedValue({ success: true });

    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });

    const reconnectButton = container.querySelector(
      '[data-testid="credentials-connection-reconnect-cred-old"]',
    ) as HTMLButtonElement | null;
    expect(reconnectButton).not.toBeNull();

    await act(async () => {
      reconnectButton?.click();
      await flush();
    });

    const input = container.querySelector(
      '[data-testid="credentials-reconnect-auth-json-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    const replacement = {
      text: vi.fn().mockResolvedValue(JSON.stringify({ tokens: { access_token: "new-token" } })),
    } as unknown as File;
    Object.defineProperty(input, "files", {
      value: [replacement],
      configurable: true,
    });

    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect(mocks.createCodexCredential).toHaveBeenCalledWith({
      authJson: { tokens: { access_token: "new-token" } },
      label: "Browser upload",
      makeDefault: true,
    });
    expect(mocks.revokeCredential).toHaveBeenCalledWith("cred-old");
    expect(mocks.showStatus).toHaveBeenCalledWith("Credential reconnected.", "success", 3000);
  });
});
