/** @vitest-environment jsdom */

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import type { FrontendTurnEngineComposerOffer } from "../../../../features/frontendFeatureModule";
import { CLAUDE_CODE_COPY } from "../../../../features/claudeCode/claudeCodeCopy";
import {
  resolveClaudeCodeSend,
  type ClaudeCodeSendDependencies,
} from "../../../../features/claudeCode/claudeCodeComposer";
import type {
  ControllerRuntimeStatusEntry,
  FetchRuntimeStatusResult,
} from "../../../../services/runtimeController/runtimes";
import { TURN_ENGINE_UNAVAILABLE_NOTICE, useChatSubmitFlow } from "../useChatSubmitFlow";

type HookOptions = Parameters<typeof useChatSubmitFlow>[0];
type HookResult = ReturnType<typeof useChatSubmitFlow>;

const PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONVERSATION_ID = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUNTIME_ID = "11111111-2222-4333-8444-555555555555";
const TEAMMATE_ID = "99999999-8888-4777-8666-555555555555";

function selection(targetHandles: string[]): ResolvedPromptAgentSelection {
  return {
    activeHandles: targetHandles,
    explicitMentionedHandles: [],
    mentionedHandles: [],
    targetHandles,
    nextStickyMentionedAgent: null,
    usesDefaultAssistantOnly: targetHandles.length === 1 && targetHandles[0] === "octo",
  };
}

function statusEntry(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return {
    runtimeId: RUNTIME_ID,
    status: "ready",
    provider: "self-hosted",
    idleTtlSeconds: 600,
    isLocal: true,
    isPreferred: false,
    health: "online",
    lastSeenAt: new Date().toISOString(),
    claudeCode: { ready: true, reason: null, cli: "2.1.314", verified: true, planSignIn: true },
    ...overrides,
  };
}

function claudeCodeOffer(overrides: Partial<ClaudeCodeSendDependencies> = {}) {
  const dependencies: ClaudeCodeSendDependencies = {
    projectId: PROJECT_ID,
    fetchRuntimeStatus: vi.fn(async () => ({
      runtimes: [statusEntry()],
      preferredRuntimeId: null,
      claudeCodeLane: true,
    }) satisfies FetchRuntimeStatusResult),
    readDesktopStatus: vi.fn(async () => ({ supported: true, found: true, path: null, consented: true })),
    readThisComputerRuntimeId: vi.fn(async () => RUNTIME_ID),
    startOnThisComputer: vi.fn(),
    ...overrides,
  };
  const offer: FrontendTurnEngineComposerOffer = {
    icon: null,
    row: {
      title: CLAUDE_CODE_COPY.rowTitle,
      description: CLAUDE_CODE_COPY.planLine,
      hint: CLAUDE_CODE_COPY.rowHint,
      testId: "composer-action-menu-claude-code",
      disabledReason: null,
      action: null,
    },
    token: {
      label: CLAUDE_CODE_COPY.tokenLabel,
      cancelLabel: CLAUDE_CODE_COPY.tokenCancel,
      testId: "composer-claude-code",
    },
    resolveSend: vi.fn((input) => resolveClaudeCodeSend(input, dependencies)),
  };
  return { offer, dependencies };
}

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useChatSubmitFlow(options);
  return null;
}

function createOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  const { offer } = claudeCodeOffer();
  return {
    activeConversationEntry: { controllerId: CONVERSATION_ID, visibility: "public", threadKind: null },
    activeConversationId: "conversation-local",
    activeConversationMessages: [],
    activeOrgId: null,
    activeProjectId: PROJECT_ID,
    appendMessages: vi.fn(),
    broadcastTyping: vi.fn(),
    clearComposerAfterQueue: vi.fn(),
    clearComposerIfUnchanged: vi.fn(),
    clearPendingBrowserLaunchMode: vi.fn(),
    consumeTurnEngineChoice: vi.fn(),
    createConversation: vi.fn(() => ({ localId: "conversation-local" })),
    createOrgInvitation: vi.fn(),
    // Neither the AI connection nor credits hold a send that runs on the
    // person's own Claude Code.
    credentialsReady: false,
    currentUserId: "user-1",
    effectiveRuntimeId: null,
    enqueueChatSendQueueItem: vi.fn(),
    enqueueServerSendQueueItem: vi.fn(async () => true),
    fetchRuntimeStatus: vi.fn(async () => null),
    focusInput: vi.fn(),
    hasHiddenBrowserSession: false,
    browserSessionOpen: false,
    humanPeerContext: null,
    imageFiles: [],
    isAssistantTyping: false,
    inputEditorState: null,
    inputValue: "Fix the failing login test",
    interruptConversationRuns: vi.fn(async () => []),
    invitePrompt: null,
    listConversationParticipants: vi.fn(async () => []),
    localTypingStateRef: { current: { isTyping: false, lastSentAt: 0 } },
    onMaybeAutoTitleConversation: vi.fn(),
    onPreparedEmailInvite: vi.fn(),
    onRecordMessage: vi.fn(async () => null),
    openInvitePrompt: vi.fn(),
    openPanelTab: vi.fn(),
    outOfCredits: true,
    pendingBrowserLaunchMode: null,
    pendingTypingBroadcastRef: { current: null },
    performSubmit: vi.fn(async () => true),
    personalBrowserActive: false,
    personalBrowserAgentControlEnabled: false,
    personalBrowserAgentError: null,
    personalBrowserAgentPhase: "idle" as const,
    personalBrowserAgentSurfaceReady: false,
    personalBrowserRetryAgentControl: vi.fn(),
    personalBrowserRuntimeOverride: null,
    personalBrowserSetAgentControlEnabled: vi.fn(),
    preferredBrowserPage: null,
    preferredRuntimeId: null,
    revealAiGatesForCurrentDraft: vi.fn(() => true),
    requestRuntimeRecovery: vi.fn(),
    // Whatever participation would say, a claimed send is never only recorded.
    resolveGroupParticipationBeforeSubmit: vi.fn(async ({ metadata }) => ({
      mode: "record_only" as const,
      metadata: {
        ...(metadata ?? {}),
        groupParticipation: { decision: "silent" },
        groupParticipationPreflight: { status: "resolved" },
      },
    })),
    resolvePromptAgentTargets: vi.fn(() => selection(["octo"])),
    runtimeControllerEnabled: true,
    runtimeReady: false,
    scrollToBottom: vi.fn(),
    sendingAttachment: false,
    sharedBrowserActive: false,
    sharedBrowserBindingPage: null,
    sharedBrowserRuntimeId: null,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    shouldAutoScrollRef: { current: false },
    submitSendIntent: vi.fn(async () => true),
    targetsOverlapActiveRuns: vi.fn(() => false),
    turnEngineOffers: { "claude-code": offer },
    ...overrides,
  };
}

describe("useChatSubmitFlow with a turn engine chosen", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function submit(
    options: HookOptions,
    ...args: Parameters<HookResult["submitMessage"]>
  ): Promise<boolean | undefined> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    let submitted: boolean | undefined;
    await act(async () => {
      submitted = await resultRef.current?.submitMessage(...args);
    });
    return submitted;
  }

  function expectNothingWentOut(options: HookOptions) {
    expect(options.performSubmit).not.toHaveBeenCalled();
    expect(options.submitSendIntent).not.toHaveBeenCalled();
    expect(options.enqueueChatSendQueueItem).not.toHaveBeenCalled();
    expect(options.enqueueServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.consumeTurnEngineChoice).not.toHaveBeenCalled();
    expect(options.clearComposerIfUnchanged).not.toHaveBeenCalled();
    expect(options.clearComposerAfterQueue).not.toHaveBeenCalled();
  }

  it("routes the composer's own Send to Octo on this computer, for this send only, with the claim", async () => {
    const options = createOptions();
    await expect(submit(options, undefined, { turnEngine: "claude-code" })).resolves.toBe(true);

    expect(options.performSubmit).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(options.performSubmit).mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      message: "Fix the failing login test",
      composerMessage: "Fix the failing login test",
      runtimeOverride: { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false },
      expectedLaneIdle: true,
      automatic: false,
    });
    expect(payload?.metadata).toMatchObject({
      turnEngine: "claude-code",
      agentSelection: { active: ["octo"], mentions: ["octo"] },
      input: { kind: "person" },
      groupParticipationPreflight: { status: "bypassed" },
    });
    // Never only recorded: no participation decision rides along.
    expect(payload?.metadata).not.toHaveProperty("groupParticipation");
    // The participation preflight saw the claim, so it can bypass the send.
    expect(options.resolveGroupParticipationBeforeSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ turnEngine: "claude-code" }) }),
    );
    // The send gate ignores the AI connection and credits.
    expect(options.showCredentialsGate).not.toHaveBeenCalled();
    expect(options.openPanelTab).not.toHaveBeenCalled();
    expect(options.revealAiGatesForCurrentDraft).not.toHaveBeenCalled();
    expect(options.requestRuntimeRecovery).not.toHaveBeenCalled();
    // The choice is used once.
    expect(options.consumeTurnEngineChoice).toHaveBeenCalledTimes(1);
    expect(options.consumeTurnEngineChoice).toHaveBeenCalledWith("claude-code");
    // No title is asked for at send.
    expect(options.onMaybeAutoTitleConversation).not.toHaveBeenCalled();
  });

  it("does not use the choice up when the send did not go out", async () => {
    const options = createOptions({ performSubmit: vi.fn(async () => false) });
    await expect(submit(options, undefined, { turnEngine: "claude-code" })).resolves.toBe(false);
    expect(options.consumeTurnEngineChoice).not.toHaveBeenCalled();
  });

  it.each([
    ["Queue", { intent: "queue" as const }, {}, CLAUDE_CODE_COPY.sendQueued],
    ["Steer", { intent: "steer" as const, expectedActiveJobId: "job-1" }, { isAssistantTyping: true }, CLAUDE_CODE_COPY.sendWhileReplying],
    [
      "a busy chat, which the preflight would queue",
      {},
      { isAssistantTyping: true, targetsOverlapActiveRuns: vi.fn(() => true) },
      CLAUDE_CODE_COPY.sendWhileReplying,
    ],
    [
      "a message still sending",
      {},
      { sendingAttachment: true },
      CLAUDE_CODE_COPY.sendWhileReplying,
    ],
    ["attachments", {}, { imageFiles: [new File(["x"], "shot.png", { type: "image/png" })] }, CLAUDE_CODE_COPY.sendAttachments],
    ["a / command", {}, { inputValue: "/goal Ship the login fix" }, CLAUDE_CODE_COPY.sendCommand],
    ["a terminal command", {}, { inputValue: "/terminal npm test" }, CLAUDE_CODE_COPY.sendCommand],
    [
      "a message to another agent",
      {},
      { resolvePromptAgentTargets: vi.fn(() => selection(["designer"])) },
      CLAUDE_CODE_COPY.sendNotOcto,
    ],
    [
      "a message to Octo and another agent",
      {},
      { resolvePromptAgentTargets: vi.fn(() => selection(["octo", "designer"])) },
      CLAUDE_CODE_COPY.sendNotOcto,
    ],
    [
      "a message that starts no agent turn",
      {},
      { resolvePromptAgentTargets: vi.fn(() => selection([])) },
      CLAUDE_CODE_COPY.sendNotOcto,
    ],
    [
      "a thread",
      {},
      { activeConversationEntry: { controllerId: CONVERSATION_ID, visibility: "public", threadKind: "agent" } },
      CLAUDE_CODE_COPY.inThread,
    ],
    ["the Personal Browser's composer", {}, { personalBrowserActive: true }, CLAUDE_CODE_COPY.sendFromBrowser],
    ["the Shared Browser's composer", {}, { sharedBrowserActive: true }, CLAUDE_CODE_COPY.sendFromBrowser],
    ["a pending new tab", {}, { pendingBrowserLaunchMode: "new_page" as const }, CLAUDE_CODE_COPY.sendNewTab],
  ])("blocks %s with a notice, keeping the text and the choice", async (_case, submitOptions, overrides, notice) => {
    const options = createOptions(overrides);
    await expect(
      submit(options, undefined, { ...submitOptions, turnEngine: "claude-code" }),
    ).resolves.toBe(false);
    expectNothingWentOut(options);
    expect(options.showStatus).toHaveBeenCalledWith(notice, "warning", 6000, undefined);
  });

  it("blocks a send that would open a private chat's invite prompt", async () => {
    const editorState = JSON.stringify({
      root: { children: [{ type: "user-mention", userId: TEAMMATE_ID, handle: "taylor", displayName: "Taylor" }] },
    });
    const options = createOptions({
      activeConversationEntry: { controllerId: CONVERSATION_ID, visibility: "private", threadKind: null },
      inputEditorState: editorState,
      inputValue: "Fix this with @Taylor",
      listConversationParticipants: vi.fn(async () => []),
    });
    await expect(submit(options, undefined, { turnEngine: "claude-code" })).resolves.toBe(false);
    expectNothingWentOut(options);
    expect(options.openInvitePrompt).not.toHaveBeenCalled();
    expect(options.showStatus).toHaveBeenCalledWith(CLAUDE_CODE_COPY.sendInvitePrompt, "warning", 6000, undefined);
  });

  it("blocks a send whose computer is not ready, and never sends it another way", async () => {
    const { offer } = claudeCodeOffer({
      fetchRuntimeStatus: vi.fn(async () => ({
        runtimes: [statusEntry({ claudeCode: { ready: false, reason: "binary_missing", cli: null, verified: null, planSignIn: false } })],
        preferredRuntimeId: null,
        claudeCodeLane: true,
      }) satisfies FetchRuntimeStatusResult),
    });
    const options = createOptions({ turnEngineOffers: { "claude-code": offer }, runtimeReady: true, credentialsReady: true, outOfCredits: false });
    await expect(submit(options, undefined, { turnEngine: "claude-code" })).resolves.toBe(false);
    expectNothingWentOut(options);
    expect(options.showStatus).toHaveBeenCalledWith(
      CLAUDE_CODE_COPY.notReady.binary_missing,
      "warning",
      6000,
      undefined,
    );
  });

  it("blocks a send for a computer that is not connected, with the Start action", async () => {
    const startOnThisComputer = vi.fn();
    const { offer } = claudeCodeOffer({ readThisComputerRuntimeId: vi.fn(async () => null), startOnThisComputer });
    const options = createOptions({ turnEngineOffers: { "claude-code": offer } });
    await expect(submit(options, undefined, { turnEngine: "claude-code" })).resolves.toBe(false);
    expectNothingWentOut(options);
    const [notice, intent, , action] = vi.mocked(options.showStatus).mock.calls[0] ?? [];
    expect([notice, intent]).toEqual([CLAUDE_CODE_COPY.sendNotConnected, "warning"]);
    expect(action?.actionLabel).toBe(CLAUDE_CODE_COPY.startAction);
    action?.onAction?.();
    expect(startOnThisComputer).toHaveBeenCalledOnce();
  });

  it("never sends with an engine the composer no longer offers", async () => {
    const options = createOptions({ turnEngineOffers: {} });
    await expect(submit(options, undefined, { turnEngine: "claude-code" })).resolves.toBe(false);
    expectNothingWentOut(options);
    expect(options.showStatus).toHaveBeenCalledWith(TURN_ENGINE_UNAVAILABLE_NOTICE, "warning", 4500);
  });

  it("refuses an automatic send whose own metadata carries the claim", async () => {
    const options = createOptions();
    await expect(
      submit(
        options,
        { message: "Retry this", editorState: null, metadata: { turnEngine: "claude-code" } },
        { automatic: true },
      ),
    ).resolves.toBe(false);
    expectNothingWentOut(options);
    expect(options.showStatus).toHaveBeenCalledWith(CLAUDE_CODE_COPY.sendNotYours, "warning", 5000);
  });

  it("sends an automatic send without the claim as usual, leaving the choice pending", async () => {
    const options = createOptions({ credentialsReady: true, outOfCredits: false, runtimeReady: true });
    await expect(
      submit(
        options,
        { message: "Continue", editorState: null, metadata: { retryOfMessageId: "message-1" } },
        { automatic: true },
      ),
    ).resolves.toBe(true);
    const payload = vi.mocked(options.performSubmit).mock.calls[0]?.[0];
    expect(payload?.metadata).not.toHaveProperty("turnEngine");
    expect(payload?.runtimeOverride ?? null).toBeNull();
    expect(options.consumeTurnEngineChoice).not.toHaveBeenCalled();
  });

  it("sends another caller's message without a claim its metadata carried", async () => {
    const options = createOptions({ credentialsReady: true, outOfCredits: false, runtimeReady: true });
    await expect(
      submit(options, {
        message: "Undo the last change",
        editorState: null,
        metadata: { turnEngine: "claude-code", undoTarget: { messageId: "message-1" } },
        runtimeOverride: { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false },
      }),
    ).resolves.toBe(true);
    const payload = vi.mocked(options.performSubmit).mock.calls[0]?.[0];
    expect(payload?.metadata).not.toHaveProperty("turnEngine");
    expect(payload?.metadata).toMatchObject({ undoTarget: { messageId: "message-1" } });
    expect(options.consumeTurnEngineChoice).not.toHaveBeenCalled();
  });
});
