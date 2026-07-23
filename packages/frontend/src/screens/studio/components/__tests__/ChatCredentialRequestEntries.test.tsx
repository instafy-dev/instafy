// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationRequestEntry } from "../ChatCredentialRequestEntries";
import { resetGithubImportRetryRegistryForTests } from "../githubImportRetryRegistry";
import type { ChatMessage } from "../../types";

const mocks = vi.hoisted(() => ({
  activeMessages: [] as ChatMessage[],
  conversations: [] as Array<{ localId: string; messages: ChatMessage[] }>,
  appendMessages: vi.fn(),
  onRecordMessage: vi.fn(),
  onSubmit: vi.fn(),
  openPanelTab: vi.fn(),
  requestUrlPush: vi.fn(),
  showStatus: vi.fn(),
  listProjectIntegrations: vi.fn(),
  upsertProjectIntegration: vi.fn(),
  importGithubProject: vi.fn(),
  beginDeviceAuth: vi.fn(),
  cancelDeviceAuth: vi.fn(),
  deviceAuthOptions: null as null | {
    onCompleted?: (input: { sessionId: string }) => Promise<unknown> | unknown;
  },
  deviceAuthSession: null as null | {
    sessionId: string;
    verificationUrl: string;
    userCode: string;
    expiresAt: string;
    pollIntervalSeconds: number;
    status: "pending" | "completed" | "failed" | "cancelled";
    error?: string | null;
  },
  deviceAuthError: null as string | null,
  inlineSecretsOnSaved: null as null | ((names: string[]) => void),
}));

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    appendMessages: mocks.appendMessages,
    conversations: mocks.conversations,
  }),
}));

vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({
    activeConversationId: "conversation-1",
    messages: mocks.activeMessages,
    onRecordMessage: mocks.onRecordMessage,
    onSubmit: mocks.onSubmit,
  }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({
    showStatus: mocks.showStatus,
  }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openPanelTab: mocks.openPanelTab,
    requestUrlPush: mocks.requestUrlPush,
  }),
}));

vi.mock("../device-auth/useDeviceAuthFlow", () => ({
  useDeviceAuthFlow: (options: typeof mocks.deviceAuthOptions) => {
    mocks.deviceAuthOptions = options;
    return {
    session: mocks.deviceAuthSession,
    error: mocks.deviceAuthError,
    busy: false,
    begin: mocks.beginDeviceAuth,
    cancel: mocks.cancelDeviceAuth,
    };
  },
}));

vi.mock("../InlineSecretsForm", () => ({
  InlineSecretsForm: ({ onSaved }: { onSaved?: (names: string[]) => void }) => {
    mocks.inlineSecretsOnSaved = onSaved ?? null;
    return null;
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    integrations: {
      listForProject: mocks.listProjectIntegrations,
      upsert: mocks.upsertProjectIntegration,
    },
    projects: {
      importGithub: mocks.importGithubProject,
    },
  },
}));

function createImportRequestMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "github-import-request",
    role: "assistant",
    content: "GitHub access is needed to import instafy-dev/private-repo.",
    timestamp: 1_700_000_000_000,
    messageType: "integration_request",
    metadata: {
      messageType: "integration_request",
      ui: { suggestedReply: "Import the repo now." },
    },
    ...overrides,
  };
}

function createImportDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "github",
    authMethods: ["oauth"],
    requiredScopes: ["repo"],
    resumeAction: {
      kind: "github_import",
      repo: "https://github.com/instafy-dev/private-repo.git",
      ref: null,
      targetPath: "repos/instafy-dev-private-repo",
    },
    ...overrides,
  };
}

describe("IntegrationRequestEntry", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderEntry = async (
    message: ChatMessage,
    details: Record<string, unknown>,
    projectId: string | null = "project-1",
  ) => {
    await act(async () => {
      root.render(
        <IntegrationRequestEntry
          message={message}
          projectId={projectId}
          details={details}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  const flushAsync = async () => {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mocks.activeMessages.splice(0);
    mocks.conversations.splice(0);
    mocks.appendMessages.mockReset();
    mocks.onRecordMessage.mockReset();
    mocks.onSubmit.mockReset();
    mocks.openPanelTab.mockReset();
    mocks.requestUrlPush.mockReset();
    mocks.showStatus.mockReset();
    mocks.listProjectIntegrations.mockReset();
    mocks.upsertProjectIntegration.mockReset();
    mocks.importGithubProject.mockReset();
    mocks.beginDeviceAuth.mockReset();
    mocks.cancelDeviceAuth.mockReset();
    mocks.deviceAuthOptions = null;
    mocks.deviceAuthSession = null;
    mocks.deviceAuthError = null;
    mocks.inlineSecretsOnSaved = null;
    resetGithubImportRetryRegistryForTests();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    mocks.listProjectIntegrations.mockResolvedValue({
      success: true,
      integrations: [
        {
          provider: "github",
          status: "connected",
          metadata: {},
        },
      ],
    });
    mocks.onSubmit.mockResolvedValue(undefined);
    mocks.onRecordMessage.mockResolvedValue(null);
    mocks.upsertProjectIntegration.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders connected GitHub as project access and retries from the suggested reply", async () => {
    const message: ChatMessage = {
      id: "integration-request",
      role: "assistant",
      content: "Use the integration action card in this message to connect GitHub.",
      timestamp: Date.now(),
      messageType: "integration_request",
      metadata: {
        messageType: "integration_request",
        ui: {
          suggestedReply: "I connected GitHub. Retry now.",
        },
      },
    };

    await act(async () => {
      root.render(
        <IntegrationRequestEntry
          message={message}
          projectId="project-1"
          details={{
            provider: "github",
            authMethods: ["oauth"],
            requiredScopes: ["repo.read"],
          }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("GitHub connected");
    expect(container.textContent).toContain("Retry the blocked request from here.");
    // One status line only — the redundant pill and duplicate copy are gone.
    expect(container.textContent).not.toContain("GitHub is connected for this project.");
    expect(container.textContent).not.toContain("instafy-dev/demo");
    expect(container.textContent).not.toContain("Import can continue.");
    const card = container.querySelector('[data-testid="integration-request-card"]') as HTMLElement | null;
    expect(card?.className).not.toContain("mx-auto");
    expect(card?.className).toContain("!max-w-[min(100%,38rem)]");
    expect(container.querySelector('[data-testid="integration-request-connected-status"]')).toBeNull();

    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement | null;
    expect(retry).not.toBeNull();

    await act(async () => {
      retry?.click();
    });

    expect(mocks.onSubmit).toHaveBeenCalledWith("conversation-1", "I connected GitHub. Retry now.");
    // After one use the historical card goes inert — the outcome arrives as a
    // newer message, so no live buttons should linger in chat history.
    expect(container.querySelector('[data-testid="integration-request-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="integration-request-retry-sent"]')).not.toBeNull();
    expect(container.textContent).toContain("Retry sent — the result appears below.");
  });

  it("single-flights a direct import retry and renders an inert resolved receipt", async () => {
    const message = createImportRequestMessage();
    let resolveImport: ((value: Record<string, unknown>) => void) | null = null;
    mocks.importGithubProject.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    mocks.onRecordMessage.mockImplementation(
      async (
        _conversationId: string,
        content: string,
        metadata: Record<string, unknown> | null,
      ): Promise<ChatMessage> => ({
        id: "recorded-import-success",
        role: "assistant",
        content,
        timestamp: message.timestamp + 100,
        metadata,
      }),
    );

    await renderEntry(message, createImportDetails());
    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement;

    await act(async () => {
      retry.click();
      retry.click();
      await Promise.resolve();
    });

    expect(mocks.importGithubProject).toHaveBeenCalledTimes(1);
    expect(mocks.onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Retrying...");

    await act(async () => {
      resolveImport?.({
        success: true,
        fileCount: 16,
        targetPath: "repos/instafy-dev-private-repo",
      });
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(container.textContent).toContain("Repository imported");
    expect(container.textContent).toContain("Imported 16 files");
    expect(container.querySelector('[data-testid="integration-request-retry"]')).toBeNull();
    expect(mocks.onRecordMessage).toHaveBeenCalledTimes(1);
    expect(mocks.onRecordMessage.mock.calls[0]?.[0]).toBe("conversation-1");
    expect(mocks.onRecordMessage.mock.calls[0]?.[2]).toMatchObject({
      githubImport: {
        sourceMessageId: message.id,
      },
    });
    expect(mocks.appendMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps one shared flight across a remount while the receipt write is pending", async () => {
    const message = createImportRequestMessage({ id: "pending-receipt-request" });
    let resolveImport: ((value: Record<string, unknown>) => void) | null = null;
    let resolveRecord: ((value: ChatMessage | null) => void) | null = null;
    mocks.importGithubProject.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    mocks.onRecordMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveRecord = resolve;
      }),
    );

    await renderEntry(message, createImportDetails());
    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
      resolveImport?.({
        success: true,
        fileCount: 9,
        targetPath: "repos/instafy-dev-private-repo",
      });
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
      }
    });

    expect(mocks.importGithubProject).toHaveBeenCalledTimes(1);
    expect(mocks.onRecordMessage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Retrying...");

    await act(async () => {
      root.render(<></>);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <IntegrationRequestEntry
          message={message}
          projectId="project-1"
          details={createImportDetails()}
        />,
      );
      await Promise.resolve();
    });

    const remountedRetry = container.querySelector(
      '[data-testid="integration-request-retry"]',
    ) as HTMLButtonElement;
    expect(remountedRetry.disabled).toBe(true);
    remountedRetry.click();
    expect(mocks.importGithubProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRecord?.(null);
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(container.textContent).toContain("Repository imported");
    expect(container.querySelector('[data-testid="integration-request-retry"]')).toBeNull();
    expect(mocks.importGithubProject).toHaveBeenCalledTimes(1);
  });

  it("reuses the controller idempotency key after a receipt failure and full reload", async () => {
    const message = createImportRequestMessage({ id: "failed-receipt-request" });
    const controllerReceipts = new Map<string, Record<string, unknown>>();
    let workspaceApplyCount = 0;
    mocks.importGithubProject.mockImplementation(async (params: { idempotencyKey?: string }) => {
      const key = params.idempotencyKey ?? "";
      const cached = controllerReceipts.get(key);
      if (cached) {
        return cached;
      }
      workspaceApplyCount += 1;
      const result = {
        success: true,
        fileCount: 5,
        targetPath: "repos/instafy-dev-private-repo",
      };
      controllerReceipts.set(key, result);
      return result;
    });
    // `null` models a failed controller message record. The import remains a
    // success, and the fallback receipt is only local until the next reload.
    mocks.onRecordMessage.mockResolvedValue(null);

    await renderEntry(message, createImportDetails());
    await act(async () => {
      (container.querySelector(
        '[data-testid="integration-request-retry"]',
      ) as HTMLButtonElement).click();
    });
    await flushAsync();

    expect(workspaceApplyCount).toBe(1);
    expect(container.textContent).toContain("Repository imported");
    const firstKey = mocks.importGithubProject.mock.calls[0]?.[0]?.idempotencyKey;
    expect(firstKey).toMatch(/^github-import-v1:/);

    // Clearing the page registry simulates a full browser reload. The
    // conversation receipt was not durable, so the card offers retry again;
    // the controller receives the same key and returns its cached result.
    resetGithubImportRetryRegistryForTests();
    await act(async () => {
      root.render(<></>);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <IntegrationRequestEntry
          message={message}
          projectId="project-1"
          details={createImportDetails()}
        />,
      );
      await Promise.resolve();
    });
    await flushAsync();
    await act(async () => {
      (container.querySelector(
        '[data-testid="integration-request-retry"]',
      ) as HTMLButtonElement).click();
    });
    await flushAsync();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.importGithubProject).toHaveBeenCalledTimes(2);
    expect(mocks.importGithubProject.mock.calls[1]?.[0]?.idempotencyKey).toBe(firstKey);
    expect(workspaceApplyCount).toBe(1);
    expect(mocks.onRecordMessage).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Repository imported");
  });

  it("uses a different idempotency key for an intentional import request", async () => {
    mocks.importGithubProject.mockResolvedValue({ success: true, fileCount: 1 });
    const first = createImportRequestMessage({ id: "intentional-import-one" });
    const second = createImportRequestMessage({ id: "intentional-import-two" });

    await renderEntry(first, createImportDetails());
    await act(async () => {
      (container.querySelector(
        '[data-testid="integration-request-retry"]',
      ) as HTMLButtonElement).click();
    });
    await flushAsync();
    await renderEntry(second, createImportDetails());
    await act(async () => {
      (container.querySelector(
        '[data-testid="integration-request-retry"]',
      ) as HTMLButtonElement).click();
    });
    await flushAsync();

    expect(mocks.importGithubProject).toHaveBeenCalledTimes(2);
    expect(mocks.importGithubProject.mock.calls[0]?.[0]?.idempotencyKey).not.toBe(
      mocks.importGithubProject.mock.calls[1]?.[0]?.idempotencyKey,
    );
  });

  it("keeps a direct import retry available and shows the controller error exactly", async () => {
    mocks.importGithubProject.mockResolvedValue({
      success: false,
      error: "The connected GitHub account cannot access this repository.",
    });

    await renderEntry(createImportRequestMessage(), createImportDetails());
    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    await flushAsync();

    expect(container.querySelector('[data-testid="integration-request-retry-error"]')?.textContent).toBe(
      "The connected GitHub account cannot access this repository.",
    );
    expect(container.querySelector('[data-testid="integration-request-retry"]')).not.toBeNull();
    expect(mocks.onRecordMessage).not.toHaveBeenCalled();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  });

  it("turns a thrown direct-import failure into an inline retryable error", async () => {
    mocks.importGithubProject.mockRejectedValue(new Error("GitHub import request timed out."));

    await renderEntry(createImportRequestMessage(), createImportDetails());
    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    await flushAsync();

    expect(container.querySelector('[data-testid="integration-request-retry-error"]')?.textContent).toBe(
      "GitHub import request timed out.",
    );
    expect(container.querySelector('[data-testid="integration-request-retry"]')).not.toBeNull();
  });

  it("auto-resumes after device auth with that session and keeps the import resolved", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    mocks.importGithubProject.mockResolvedValue({
      success: true,
      fileCount: 7,
      targetPath: "repos/instafy-dev-private-repo",
    });

    await renderEntry(createImportRequestMessage(), createImportDetails());
    let completion: unknown;
    await act(async () => {
      completion = await mocks.deviceAuthOptions?.onCompleted?.({ sessionId: "github-session-1" });
    });
    await flushAsync();

    expect(completion).toEqual({ success: true });
    expect(mocks.importGithubProject).toHaveBeenCalledWith(
      expect.objectContaining({
        githubDeviceAuthSessionId: "github-session-1",
      }),
    );
    expect(container.textContent).toContain("Repository imported");
    expect(container.querySelector('[data-testid="integration-request-retry"]')).toBeNull();
  });

  it("keeps GitHub connected and shows the real error when device-auth auto-resume fails", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    mocks.importGithubProject.mockResolvedValue({
      success: false,
      error: "The newly connected account does not have access to this repository.",
    });

    await renderEntry(createImportRequestMessage(), createImportDetails());
    let completion: unknown;
    await act(async () => {
      completion = await mocks.deviceAuthOptions?.onCompleted?.({ sessionId: "github-session-2" });
    });
    await flushAsync();

    expect(completion).toEqual({
      success: false,
      error: "The newly connected account does not have access to this repository.",
    });
    expect(container.textContent).toContain("GitHub connected");
    expect(container.querySelector('[data-testid="integration-request-retry-error"]')?.textContent).toBe(
      "The newly connected account does not have access to this repository.",
    );
    expect(container.textContent).toContain("Use a different account");
    expect(container.querySelector('[data-testid="integration-request-retry"]')).not.toBeNull();
  });

  it("shows a token-triggered import failure on the token-connected request card", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    mocks.importGithubProject.mockResolvedValue({
      success: false,
      error: "This token cannot read the requested repository.",
    });
    const details = createImportDetails({
      authMethods: ["secret"],
      suggestedSecretNames: ["GITHUB_TOKEN"],
      suggestedSecrets: [{ name: "GITHUB_TOKEN", description: "One-repo token" }],
    });

    await renderEntry(createImportRequestMessage(), details);
    expect(mocks.inlineSecretsOnSaved).not.toBeNull();
    await act(async () => {
      mocks.inlineSecretsOnSaved?.(["GITHUB_TOKEN"]);
    });
    await flushAsync();

    expect(container.textContent).toContain("GitHub connected");
    expect(container.querySelector('[data-testid="integration-request-retry-error"]')?.textContent).toBe(
      "This token cannot read the requested repository.",
    );
    expect(mocks.onSubmit).not.toHaveBeenCalled();
  });

  it("activates the saved project token before importing so stored OAuth cannot win", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    const events: string[] = [];
    mocks.upsertProjectIntegration.mockImplementation(async () => {
      events.push("token-integration-upserted");
      return { success: true };
    });
    mocks.importGithubProject.mockImplementation(async () => {
      events.push("import-executed");
      return {
        success: true,
        fileCount: 4,
        targetPath: "repos/instafy-dev-private-repo",
      };
    });
    const details = createImportDetails({
      authMethods: ["secret"],
      suggestedSecretNames: ["GITHUB_TOKEN"],
      suggestedSecrets: [{ name: "GITHUB_TOKEN", description: "One-repo token" }],
    });

    await renderEntry(createImportRequestMessage(), details);
    await act(async () => {
      mocks.inlineSecretsOnSaved?.(["GITHUB_TOKEN"]);
      mocks.inlineSecretsOnSaved?.(["GITHUB_TOKEN"]);
    });
    await flushAsync();

    expect(events).toEqual(["token-integration-upserted", "import-executed"]);
    expect(mocks.upsertProjectIntegration).toHaveBeenCalledTimes(1);
    expect(mocks.importGithubProject).toHaveBeenCalledTimes(1);
    expect(mocks.upsertProjectIntegration).toHaveBeenCalledWith(
      "project-1",
      "github",
      expect.objectContaining({
        status: "connected",
        connectionType: "token",
        metadata: expect.objectContaining({
          authMode: "token",
          enabled: true,
        }),
      }),
    );
    expect(container.textContent).toContain("Repository imported");
  });

  it("keeps token activation inside the shared flight across a remount", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    let resolveTokenActivation: ((value: { success: boolean }) => void) | null = null;
    mocks.upsertProjectIntegration.mockReturnValue(
      new Promise((resolve) => {
        resolveTokenActivation = resolve;
      }),
    );
    mocks.importGithubProject.mockResolvedValue({
      success: true,
      fileCount: 3,
      targetPath: "repos/instafy-dev-private-repo",
    });
    const message = createImportRequestMessage({ id: "token-remount-request" });
    const details = createImportDetails({
      authMethods: ["secret"],
      suggestedSecretNames: ["GITHUB_TOKEN"],
      suggestedSecrets: [{ name: "GITHUB_TOKEN", description: "One-repo token" }],
    });

    await renderEntry(message, details);
    await act(async () => {
      mocks.inlineSecretsOnSaved?.(["GITHUB_TOKEN"]);
      await Promise.resolve();
    });
    expect(mocks.upsertProjectIntegration).toHaveBeenCalledTimes(1);
    expect(mocks.importGithubProject).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<></>);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <IntegrationRequestEntry
          message={message}
          projectId="project-1"
          details={details}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      mocks.inlineSecretsOnSaved?.(["GITHUB_TOKEN"]);
      await Promise.resolve();
    });

    expect(mocks.upsertProjectIntegration).toHaveBeenCalledTimes(1);
    expect(mocks.importGithubProject).not.toHaveBeenCalled();

    await act(async () => {
      resolveTokenActivation?.({ success: true });
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
    });

    expect(mocks.upsertProjectIntegration).toHaveBeenCalledTimes(1);
    expect(mocks.importGithubProject).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Repository imported");
  });

  it("does not import when the saved project token cannot be activated", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    mocks.upsertProjectIntegration.mockResolvedValue({
      success: false,
      error: "Unable to select the saved token for this project.",
    });
    const details = createImportDetails({
      authMethods: ["secret"],
      suggestedSecretNames: ["GH_TOKEN"],
      suggestedSecrets: [{ name: "GH_TOKEN", description: "One-repo token" }],
    });

    await renderEntry(createImportRequestMessage(), details);
    await act(async () => {
      mocks.inlineSecretsOnSaved?.(["GH_TOKEN"]);
    });
    await flushAsync();

    expect(mocks.importGithubProject).not.toHaveBeenCalled();
    expect(container.textContent).toContain("GitHub access required");
    expect(container.querySelector('[data-testid="integration-request-retry-error"]')?.textContent).toBe(
      "Unable to select the saved token for this project.",
    );
  });

  it("uses a persisted import receipt in the containing conversation after remount", async () => {
    const request = createImportRequestMessage();
    const receipt: ChatMessage = {
      id: "persisted-import-receipt",
      role: "assistant",
      content: "Imported 11 files from instafy-dev/private-repo.",
      timestamp: request.timestamp + 1,
      metadata: {
        githubImport: {
          projectId: "project-1",
          repo: "instafy-dev/private-repo",
          ref: null,
          targetPath: "repos/instafy-dev-private-repo",
          fileCount: 11,
          sourceMessageId: request.id,
        },
      },
    };
    mocks.conversations.push({
      localId: "conversation-containing-request",
      messages: [request, receipt],
    });

    await renderEntry(request, createImportDetails());

    expect(container.textContent).toContain("Repository imported");
    expect(container.textContent).toContain("Imported 11 files");
    expect(container.querySelector('[data-testid="integration-request-retry"]')).toBeNull();
    expect(mocks.importGithubProject).not.toHaveBeenCalled();
  });

  it("does not resolve an import request from an unrelated repository receipt", async () => {
    const request = createImportRequestMessage();
    mocks.activeMessages.push(request, {
      id: "other-import-receipt",
      role: "assistant",
      content: "Imported another repo.",
      timestamp: request.timestamp + 1,
      metadata: {
        githubImport: {
          projectId: "project-1",
          repo: "instafy-dev/another-repo",
          ref: null,
          targetPath: "repos/instafy-dev-another-repo",
          fileCount: 2,
        },
      },
    });

    await renderEntry(request, createImportDetails());

    expect(container.textContent).not.toContain("Repository imported");
    expect(container.querySelector('[data-testid="integration-request-retry"]')).not.toBeNull();
  });

  it("shows a suggested-request submit error and allows another attempt", async () => {
    mocks.onSubmit.mockRejectedValue(new Error("Unable to start the retry run."));
    const message = createImportRequestMessage({
      id: "generic-integration-request",
      content: "Connect GitHub to continue.",
      metadata: {
        messageType: "integration_request",
        ui: { suggestedReply: "I connected GitHub. Retry now." },
      },
    });

    await renderEntry(message, {
      provider: "github",
      authMethods: ["oauth"],
    });
    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
    });
    await flushAsync();

    expect(container.querySelector('[data-testid="integration-request-retry-error"]')?.textContent).toBe(
      "Unable to start the retry run.",
    );
    expect(container.querySelector('[data-testid="integration-request-retry"]')).not.toBeNull();
  });

  it("waits for the disconnect update and blocks retry actions while switching accounts", async () => {
    let resolveDisconnect: ((value: { success: boolean }) => void) | null = null;
    mocks.upsertProjectIntegration.mockReturnValue(
      new Promise((resolve) => {
        resolveDisconnect = resolve;
      }),
    );
    mocks.importGithubProject.mockResolvedValue({ success: true, fileCount: 1 });

    await renderEntry(createImportRequestMessage(), createImportDetails());
    const disconnect = container.querySelector(
      'button[aria-label="Disconnect GitHub"]',
    ) as HTMLButtonElement;
    const retry = container.querySelector('[data-testid="integration-request-retry"]') as HTMLButtonElement;
    await act(async () => {
      disconnect.click();
      await Promise.resolve();
    });

    expect(disconnect.disabled).toBe(true);
    expect(retry.disabled).toBe(true);
    retry.click();
    expect(mocks.importGithubProject).not.toHaveBeenCalled();

    await act(async () => {
      resolveDisconnect?.({ success: true });
      await Promise.resolve();
    });
    await flushAsync();

    expect(container.textContent).toContain("GitHub access required");
    expect(container.querySelector('[data-testid="integration-request-connect-github"]')).not.toBeNull();
  });

  it("shows a device-auth start error after switching accounts", async () => {
    mocks.listProjectIntegrations.mockResolvedValue({ success: true, integrations: [] });
    mocks.deviceAuthError =
      "GitHub device-code login is not configured. Set GITHUB_DEVICE_AUTH_CLIENT_ID in the controller environment.";

    await renderEntry(createImportRequestMessage(), createImportDetails());
    await flushAsync();

    expect(
      container.querySelector('[data-testid="integration-request-device-auth-error"]')?.textContent,
    ).toContain("GitHub device-code login is not configured");
    expect(container.querySelector('[data-testid="integration-request-connect-github"]')).not.toBeNull();
  });
});
