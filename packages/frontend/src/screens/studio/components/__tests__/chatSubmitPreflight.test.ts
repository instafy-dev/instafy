import { beforeEach, describe, expect, it, vi } from "vitest";

import { runChatSubmitPreflight } from "../chatSubmitPreflight";

const mocks = vi.hoisted(() => ({
  executeGithubProjectImport: vi.fn(),
}));

vi.mock("../githubImport", () => ({
  executeGithubProjectImport: mocks.executeGithubProjectImport,
}));

function createParams(overrides: Partial<Parameters<typeof runChatSubmitPreflight>[0]> = {}) {
  return {
    activeConversationControllerId: "conversation-controller",
    activeConversationId: "conversation-local",
    activeConversationVisibility: "public",
    activeOrgId: "org-1",
    activeProjectId: "project-1",
    allowWhileBusy: false,
    appendMessages: vi.fn(),
    attachedImageCount: 0,
    clearQueuedComposerDraft: vi.fn(),
    clearSubmittedComposerDraft: vi.fn(),
    consumeBrowserComposerTarget: vi.fn(),
    createConversationId: vi.fn(() => "conversation-local"),
    createOrgInvitation: vi.fn(),
    credentialsReady: true,
    currentUserId: "user-1",
    focusInput: vi.fn(),
    handleOutOfCredits: vi.fn(() => false),
    inputEditorState: "editor-state",
    isAssistantTyping: false,
    messageRequiresAi: true,
    messageRequiresRuntime: true,
    messageToSend: "Ask Octo to inspect the repo.",
    onMaybeAutoTitleConversation: vi.fn(),
    onPreparedEmailInvite: vi.fn(),
    onRecordMessage: vi.fn(),
    override: undefined,
    pinToBottom: vi.fn(),
    queueCurrentMessage: vi.fn(),
    queueMessageToServer: null,
    recoverRuntime: vi.fn(),
    resolveRuntimeAvailable: vi.fn(async () => false),
    runtimeControllerEnabled: true,
    sendingAttachment: false,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    targetAgentHandles: ["octo"],
    targetsOverlapActiveRuns: vi.fn(() => false),
    trimmed: "Ask Octo to inspect the repo.",
    ...overrides,
  } satisfies Parameters<typeof runChatSubmitPreflight>[0];
}

describe("chatSubmitPreflight", () => {
  beforeEach(() => {
    mocks.executeGithubProjectImport.mockReset();
  });

  it("gates missing AI credentials before checking credits or resolving a runtime", async () => {
    const params = createParams({
      credentialsReady: false,
      handleOutOfCredits: vi.fn(() => true),
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.showCredentialsGate).toHaveBeenCalledTimes(1);
    expect(params.handleOutOfCredits).not.toHaveBeenCalled();
    expect(params.resolveRuntimeAvailable).not.toHaveBeenCalled();
    expect(params.recoverRuntime).not.toHaveBeenCalled();
    expect(params.queueCurrentMessage).not.toHaveBeenCalled();
  });

  it("checks credits before resolving a runtime once AI credentials are ready", async () => {
    const params = createParams({
      credentialsReady: true,
      handleOutOfCredits: vi.fn(() => true),
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.handleOutOfCredits).toHaveBeenCalledTimes(1);
    expect(params.showCredentialsGate).not.toHaveBeenCalled();
    expect(params.resolveRuntimeAvailable).not.toHaveBeenCalled();
    expect(params.recoverRuntime).not.toHaveBeenCalled();
  });

  it("lets text-only runtime prompts reach the controller queue when the runtime is offline", async () => {
    const params = createParams();

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "continue",
      editorState: "editor-state",
    });

    expect(params.recoverRuntime).toHaveBeenCalledTimes(1);
    expect(params.queueCurrentMessage).not.toHaveBeenCalled();
    expect(params.clearQueuedComposerDraft).not.toHaveBeenCalled();
  });

  it("lets queued text prompts retry through the durable controller path before runtime is ready", async () => {
    const params = createParams({
      override: {
        message: "Continue the Demo assessment.",
        editorState: "queued-editor-state",
        browserLaunchMode: null,
        browserPageTarget: null,
      },
      inputEditorState: "ignored-live-editor-state",
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "continue",
      editorState: "queued-editor-state",
    });

    expect(params.recoverRuntime).toHaveBeenCalledTimes(1);
    expect(params.queueCurrentMessage).not.toHaveBeenCalled();
  });

  it("still waits for runtime recovery before sending image attachments", async () => {
    const params = createParams({
      attachedImageCount: 1,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.recoverRuntime).toHaveBeenCalledTimes(1);
    expect(params.showStatus).toHaveBeenCalledWith(
      "Starting runtime… Send images once it is ready.",
      "info",
      4000,
    );
    expect(params.queueCurrentMessage).not.toHaveBeenCalled();
  });

  it("keeps the local browser queue fallback when runtime control is unavailable", async () => {
    const params = createParams({
      runtimeControllerEnabled: false,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.queueCurrentMessage).toHaveBeenCalledWith("editor-state");
    expect(params.clearQueuedComposerDraft).toHaveBeenCalledTimes(1);
    expect(params.showStatus).toHaveBeenCalledWith(
      "Runtime control is unavailable right now.",
      "warning",
      4000,
    );
  });

  it("queues busy-target messages to the controller send queue when available", async () => {
    const params = createParams({
      isAssistantTyping: true,
      queueMessageToServer: vi.fn(async () => true),
      resolveRuntimeAvailable: vi.fn(async () => true),
      targetsOverlapActiveRuns: vi.fn(() => true),
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.queueMessageToServer).toHaveBeenCalledTimes(1);
    expect(params.queueCurrentMessage).not.toHaveBeenCalled();
    expect(params.clearQueuedComposerDraft).toHaveBeenCalledTimes(1);
    expect(params.consumeBrowserComposerTarget).toHaveBeenCalledTimes(1);
    expect(params.focusInput).toHaveBeenCalledTimes(1);
  });

  it("falls back to the localStorage queue when the server enqueue is unavailable", async () => {
    const params = createParams({
      isAssistantTyping: true,
      queueMessageToServer: vi.fn(async () => false),
      resolveRuntimeAvailable: vi.fn(async () => true),
      targetsOverlapActiveRuns: vi.fn(() => true),
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.queueMessageToServer).toHaveBeenCalledTimes(1);
    expect(params.queueCurrentMessage).toHaveBeenCalledWith("editor-state");
    expect(params.clearQueuedComposerDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps attachment sends on the local queue so upload ordering is preserved", async () => {
    const params = createParams({
      queueMessageToServer: vi.fn(async () => true),
      resolveRuntimeAvailable: vi.fn(async () => true),
      sendingAttachment: true,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(params.queueMessageToServer).not.toHaveBeenCalled();
    expect(params.queueCurrentMessage).toHaveBeenCalledWith("editor-state");
  });

  it("binds slash-command email invitations to the active private conversation", async () => {
    const appendMessages = vi.fn();
    const onRecordMessage = vi.fn().mockResolvedValue(null);
    const createOrgInvitation = vi.fn().mockResolvedValue({
      acceptUrl: "https://instafy.dev/invite?token=one-time-secret",
      email: "guest@example.com",
      role: "viewer",
      expiresAt: null,
    });
    const params = createParams({
      activeConversationVisibility: "private",
      appendMessages,
      createOrgInvitation,
      messageToSend: "/invite guest@example.com viewer",
      onRecordMessage,
      trimmed: "/invite guest@example.com viewer",
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: true,
    });
    expect(createOrgInvitation).toHaveBeenCalledWith({
      orgId: "org-1",
      projectId: "project-1",
      conversationId: "conversation-controller",
      email: "guest@example.com",
      role: "viewer",
    });
    expect(params.onPreparedEmailInvite).toHaveBeenCalledWith({
      acceptUrl: "https://instafy.dev/invite?token=one-time-secret",
      email: "guest@example.com",
      role: "viewer",
    });
    expect(JSON.stringify(appendMessages.mock.calls)).not.toContain("one-time-secret");
    expect(JSON.stringify(onRecordMessage.mock.calls)).not.toContain("one-time-secret");
  });

  it("does not turn a deliberative GitHub question into an import", async () => {
    const prompt =
      "Do you think we should import https://github.com/octocat/Hello-World?";
    const params = createParams({
      messageToSend: prompt,
      resolveRuntimeAvailable: vi.fn(async () => true),
      trimmed: prompt,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "continue",
      editorState: "editor-state",
    });

    expect(mocks.executeGithubProjectImport).not.toHaveBeenCalled();
    expect(params.onRecordMessage).not.toHaveBeenCalled();
    expect(params.appendMessages).not.toHaveBeenCalled();
    expect(params.clearSubmittedComposerDraft).not.toHaveBeenCalled();
    expect(params.resolveRuntimeAvailable).toHaveBeenCalledTimes(1);
  });

  it("records a deterministic GitHub resume action without a chat suggestion", async () => {
    mocks.executeGithubProjectImport.mockResolvedValue({
      success: false,
      error: "GitHub repo or ref not found (or you do not have access).",
    });
    const onRecordMessage = vi.fn().mockResolvedValue(null);
    const prompt = "Import https://github.com/example/private-repo please";
    const params = createParams({
      messageToSend: prompt,
      onRecordMessage,
      trimmed: prompt,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: true,
    });

    expect(mocks.executeGithubProjectImport).toHaveBeenCalledTimes(1);
    const importParams = mocks.executeGithubProjectImport.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(importParams?.["idempotencyKey"]).toMatch(/^github-import-v1:[a-f0-9]{16}$/);
    expect(onRecordMessage).toHaveBeenCalledTimes(2);
    const assistantMetadata = onRecordMessage.mock.calls[1]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(assistantMetadata?.["ui"]).toBeUndefined();
    expect(assistantMetadata?.["messageType"]).toBe("integration_request");
    expect(assistantMetadata?.["details"]).toMatchObject({
      provider: "github",
      resumeAction: {
        kind: "github_import",
        repo: "https://github.com/example/private-repo",
        idempotencyKey: importParams?.["idempotencyKey"],
      },
    });
  });

  it("keeps operational import failures out of the GitHub authentication card", async () => {
    mocks.executeGithubProjectImport.mockResolvedValue({
      success: false,
      error: "origin apply request timed out",
      errorCode: "github_download_failed",
      status: 502,
    });
    const onRecordMessage = vi.fn().mockResolvedValue(null);
    const prompt = "Import https://github.com/example/large-repo please";
    const params = createParams({
      messageToSend: prompt,
      onRecordMessage,
      trimmed: prompt,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: true,
    });

    expect(onRecordMessage).toHaveBeenCalledTimes(2);
    const assistantMetadata = onRecordMessage.mock.calls[1]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(assistantMetadata).toMatchObject({
      messageType: "integration_error",
      details: {
        provider: "github",
        code: "github_download_failed",
        retryable: true,
      },
    });
    expect(assistantMetadata?.["details"]).not.toHaveProperty("resumeAction");
  });

  it("surfaces the local GitHub attachment error before AI credential gates", async () => {
    const prompt = "Import https://github.com/octocat/Hello-World";
    const params = createParams({
      attachedImageCount: 1,
      credentialsReady: false,
      messageToSend: prompt,
      trimmed: prompt,
    });

    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "handled",
      submitted: false,
    });

    expect(mocks.executeGithubProjectImport).not.toHaveBeenCalled();
    expect(params.showCredentialsGate).not.toHaveBeenCalled();
    expect(params.showStatus).toHaveBeenCalledWith(
      "GitHub repo imports do not support image attachments.",
      "error",
      4000,
    );
  });
});
