// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSettingsCard } from "../CredentialsSettingsCard";

const mocks = vi.hoisted(() => ({
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
    expect(container.textContent).toContain("The selected upstream AI login/token is stale.");
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
