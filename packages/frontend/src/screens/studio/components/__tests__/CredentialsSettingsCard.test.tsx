// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";
import { clearPendingAgentProfileTarget, readPendingAgentProfileTarget, setPendingAgentProfileTarget } from "../agentProfileDeepLink";

vi.mock("../../useStudioDesktopLayout", () => ({
  useStudioDesktopLayout: () => mocks.isDesktop,
}));

const mocks = vi.hoisted(() => ({
  isDesktop: true,
  user: { id: "user-1", email: "playwright@instafy.dev" },
  clearDefaultCredential: vi.fn(),
  createCodexCredential: vi.fn(),
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
    user: mocks.user,
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
      create: vi.fn(),
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

// Synthetic input for proxyError's structured-code contract, not provider wire-format evidence.
const TOKEN_EXPIRED_ERROR = 'unexpected status 502 Bad Gateway: {"error":{"code":"token_expired"},"status":401}';

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
    clearPendingAgentProfileTarget();
    mocks.isDesktop = true;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, this.dataset.testid === "credentials-settings-card" ? 960 : 0, 0);
    });
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    document.body.appendChild(container);
    root = createRoot(container);

    mocks.clearDefaultCredential.mockReset();
    mocks.createCodexCredential.mockReset();
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearPendingAgentProfileTarget();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("separates providers and agents with the shared settings navigation", async () => {
    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });

    expect(container.querySelector('[data-testid="credentials-add-connection"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bots-create"]')).toBeNull();
    const agents = container.querySelector<HTMLButtonElement>('[data-testid="settings-category-agents"]');
    expect(agents).not.toBeNull();
    await act(async () => { agents!.click(); await flush(); });
    expect(container.querySelector('[data-testid="bots-create"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="credentials-add-connection"]')).toBeNull();

    const providers = container.querySelector<HTMLButtonElement>('[data-testid="settings-category-providers"]');
    await act(async () => { providers!.click(); await flush(); });
    expect(container.querySelector('[data-testid="credentials-add-connection"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bots-create"]')).toBeNull();
    expect(mocks.listCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
  });

  it("starts on agents for a pending profile target, even when the agent is unavailable", async () => {
    setPendingAgentProfileTarget("missing-bot");
    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });
    expect(container.textContent).toContain("No bots yet");
    expect(container.querySelector('[data-testid="credentials-add-connection"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-category-providers"]')).not.toBeNull();
    expect(readPendingAgentProfileTarget()).toBe("missing-bot");
    expect(document.querySelector('[data-testid="agent-profile-modal"]')).toBeNull();
  });

  it.each(["octo", "test-bot"])("opens and consumes a pending %s profile after agents load", async (handle) => {
    let resolveAgents!: (value: unknown) => void;
    mocks.listAgents.mockReturnValue(new Promise((resolve) => { resolveAgents = resolve; }));
    setPendingAgentProfileTarget(`@${handle.toUpperCase()}`);

    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });
    expect(container.querySelector('[data-testid="settings-category-agents"]')?.getAttribute("aria-current"))
      .toBe("page");
    expect(container.querySelector('[data-testid="credentials-add-connection"]')).toBeNull();
    expect(document.querySelector('[data-testid="agent-profile-modal"]')).toBeNull();
    expect(readPendingAgentProfileTarget()).toBe(handle);

    await act(async () => {
      resolveAgents({ success: true, agents: [{
        id: `agent-${handle}`,
        handle,
        displayName: "Test agent",
        description: "Synthetic profile",
        avatarSeed: "test-avatar",
        provider: "openai",
        model: null,
        reasoningEffort: null,
        credentialId: null,
        runtimeId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }] });
      await flush();
    });
    const modal = document.querySelector('[data-testid="agent-profile-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector<HTMLInputElement>('[data-testid="agent-profile-display-name-input"]')?.value)
      .toBe("Test agent");
    expect(readPendingAgentProfileTarget()).toBeNull();

    const close = modal?.querySelector<HTMLButtonElement>('[aria-label="Close"]');
    expect(close).not.toBeNull();
    await act(async () => { close!.click(); await flush(); });
    expect(document.querySelector('[data-testid="agent-profile-modal"]')).toBeNull();
    await act(async () => { root.render(<CredentialsSettingsCard />); await flush(); });
    expect(document.querySelector('[data-testid="agent-profile-modal"]')).toBeNull();
    expect(readPendingAgentProfileTarget()).toBeNull();
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("offers the shared category picker in a narrow pane (desktop: %s)", async (isDesktop) => {
    mocks.isDesktop = isDesktop;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 480, 0));
    await act(async () => {
      root.render(<CredentialsSettingsCard />);
      await flush();
    });
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="settings-category-nav-picker"]');
    expect(picker?.textContent).toContain("Providers");
    await act(async () => { picker!.click(); await flush(); });
    const agents = Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
      .find((item) => item.textContent?.includes("Agents"));
    expect(agents).toBeDefined();
    await act(async () => { agents!.click(); await flush(); });
    expect(picker?.textContent).toContain("Agents");
    expect(container.querySelector('[data-testid="bots-create"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="credentials-add-connection"]')).toBeNull();
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
