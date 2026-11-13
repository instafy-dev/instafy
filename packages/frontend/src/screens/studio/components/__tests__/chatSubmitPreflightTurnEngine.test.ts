import { beforeEach, describe, expect, it, vi } from "vitest";

import { runChatSubmitPreflight } from "../chatSubmitPreflight";

const mocks = vi.hoisted(() => ({
  executeGithubProjectImport: vi.fn(),
}));

vi.mock("../githubImport", () => ({
  executeGithubProjectImport: mocks.executeGithubProjectImport,
}));

// A send the composer routed to the person's own Claude Code: it carries a
// turn-engine claim and is pinned to this computer's runtime for this send.
function createTurnEngineParams(overrides: Partial<Parameters<typeof runChatSubmitPreflight>[0]> = {}) {
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
    credentialsReady: false,
    currentUserId: "user-1",
    focusInput: vi.fn(),
    handleOutOfCredits: vi.fn(() => true),
    inputEditorState: "editor-state",
    isAssistantTyping: false,
    messageRequiresAi: true,
    messageRequiresRuntime: true,
    messageToSend: "Please import https://github.com/octo-org/octo-repo and fix its tests",
    onMaybeAutoTitleConversation: vi.fn(),
    onPreparedEmailInvite: vi.fn(),
    onRecordMessage: vi.fn(),
    override: undefined,
    pinToBottom: vi.fn(),
    queueCurrentMessage: vi.fn(),
    queueMessageToServer: vi.fn(async () => true),
    recoverRuntime: vi.fn(),
    resolveRuntimeAvailable: vi.fn(async () => true),
    runtimeControllerEnabled: true,
    sendingAttachment: false,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    targetAgentHandles: ["octo"],
    targetsOverlapActiveRuns: vi.fn(() => true),
    trimmed: "Please import https://github.com/octo-org/octo-repo and fix its tests",
    turnEngineSend: true,
    ...overrides,
  } satisfies Parameters<typeof runChatSubmitPreflight>[0];
}

describe("chatSubmitPreflight for a turn-engine send", () => {
  beforeEach(() => {
    mocks.executeGithubProjectImport.mockReset();
  });

  it("goes out as the person's message: no AI or credit gate, no local GitHub import", async () => {
    const params = createTurnEngineParams();
    await expect(runChatSubmitPreflight(params)).resolves.toEqual({
      status: "continue",
      editorState: "editor-state",
    });
    expect(params.showCredentialsGate).not.toHaveBeenCalled();
    expect(params.handleOutOfCredits).not.toHaveBeenCalled();
    expect(mocks.executeGithubProjectImport).not.toHaveBeenCalled();
    expect(params.onRecordMessage).not.toHaveBeenCalled();
    expect(params.onMaybeAutoTitleConversation).not.toHaveBeenCalled();
  });

  it("is never taken as an /invite command", async () => {
    const params = createTurnEngineParams({
      messageToSend: "/invite teammate@example.com",
      trimmed: "/invite teammate@example.com",
    });
    await expect(runChatSubmitPreflight(params)).resolves.toMatchObject({ status: "continue" });
    expect(params.createOrgInvitation).not.toHaveBeenCalled();
    expect(params.onMaybeAutoTitleConversation).not.toHaveBeenCalled();
  });

  it("is never queued behind a busy agent", async () => {
    const params = createTurnEngineParams({ isAssistantTyping: true });
    await expect(runChatSubmitPreflight(params)).resolves.toMatchObject({ status: "continue" });
    expect(params.queueMessageToServer).not.toHaveBeenCalled();
    expect(params.queueCurrentMessage).not.toHaveBeenCalled();
    expect(params.clearQueuedComposerDraft).not.toHaveBeenCalled();
  });

  it("keeps every gate for the same send without the claim", async () => {
    const params = createTurnEngineParams({ turnEngineSend: false, messageToSend: "Fix its tests", trimmed: "Fix its tests" });
    await expect(runChatSubmitPreflight(params)).resolves.toEqual({ status: "handled", submitted: false });
    expect(params.showCredentialsGate).toHaveBeenCalledTimes(1);
  });
});
