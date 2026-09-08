/** @vitest-environment jsdom */

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import { useChatSubmitFlow } from "../useChatSubmitFlow";
import { queuedMentionComposer, QUEUED_MENTION_USER_ID } from "./fixtures/queuedMentionComposer";
import { readQueuedComposerMetadata } from "../chatSendQueueComposer";

type HookOptions = Parameters<typeof useChatSubmitFlow>[0];
type HookResult = ReturnType<typeof useChatSubmitFlow>;

const OCTO_SELECTION: ResolvedPromptAgentSelection = {
  activeHandles: ["octo"],
  explicitMentionedHandles: [],
  mentionedHandles: [],
  targetHandles: ["octo"],
  nextStickyMentionedAgent: null,
  usesDefaultAssistantOnly: true,
};

const TYPED_DRAFT = "Rewrite the pricing paragraph once you are done";
const UNDO_REQUEST = "Please undo the change from your message (id 2ee0ad74).";

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

/**
 * Mirrors useChatSubmitDispatch's real clearing behavior: the composer is only
 * emptied when it still holds the draft the caller says was consumed. Tracking
 * the live value here makes the assertions about the user's typed text real
 * rather than assertions about which argument was passed.
 */
function createComposer(initialDraft: string) {
  const composer = { draft: initialDraft };
  const clearComposerIfUnchanged = vi.fn((_conversationId: string, expectedDraft: string) => {
    if (composer.draft.trim() !== expectedDraft.trim()) {
      return;
    }
    composer.draft = "";
  });
  return {
    composer,
    clearComposerIfUnchanged,
    clearComposerAfterQueue: vi.fn((conversationId: string, expectedDraft: string) => {
      clearComposerIfUnchanged(conversationId, expectedDraft);
    }),
  };
}

function createOptions(overrides: Partial<HookOptions> = {}): HookOptions {
  return {
    activeConversationEntry: {
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      visibility: "public",
    },
    activeConversationId: "conversation-local",
    activeConversationMessages: [],
    activeOrgId: null,
    activeProjectId: null,
    appendMessages: vi.fn(),
    broadcastTyping: vi.fn(),
    clearComposerAfterQueue: vi.fn(),
    clearComposerIfUnchanged: vi.fn(),
    clearPendingBrowserLaunchMode: vi.fn(),
    createConversation: vi.fn(() => ({ localId: "conversation-local" })),
    createOrgInvitation: vi.fn(),
    credentialsReady: true,
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
    // The assistant is mid-reply and the target agent is the busy one, so the
    // send takes the queue path instead of dispatching.
    isAssistantTyping: true,
    inputEditorState: null,
    inputValue: TYPED_DRAFT,
    interruptConversationRuns: vi.fn(async () => []),
    invitePrompt: null,
    listConversationParticipants: vi.fn(async () => []),
    localTypingStateRef: { current: { isTyping: false, lastSentAt: 0 } },
    onMaybeAutoTitleConversation: vi.fn(),
    onPreparedEmailInvite: vi.fn(),
    onRecordMessage: vi.fn(async () => null),
    openInvitePrompt: vi.fn(),
    openPanelTab: vi.fn(),
    outOfCredits: false,
    pendingBrowserLaunchMode: null,
    pendingTypingBroadcastRef: { current: null },
    performSubmit: vi.fn(async () => undefined),
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
    resolveGroupParticipationBeforeSubmit: vi.fn(async ({ metadata }) => ({
      mode: "unchanged" as const,
      metadata: metadata ?? null,
    })),
    resolvePromptAgentTargets: vi.fn(() => OCTO_SELECTION),
    runtimeControllerEnabled: true,
    runtimeReady: true,
    scrollToBottom: vi.fn(),
    sendingAttachment: false,
    sharedBrowserActive: false,
    sharedBrowserRuntimeId: null,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    shouldAutoScrollRef: { current: false },
    softPrefillSuggestion: null,
    submitSendIntent: vi.fn(async () => true),
    targetsOverlapActiveRuns: vi.fn(() => true),
    ...overrides,
  };
}

describe("useChatSubmitFlow queued composer draft", () => {
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

  it("keeps the typed draft when a programmatic send is queued behind a busy assistant", async () => {
    // The conversational-undo chip sends its own text while the user is still
    // typing. Queueing it must not empty the composer: that text never came
    // from the draft, so clearing it would destroy unsent work.
    const { composer, clearComposerAfterQueue, clearComposerIfUnchanged } =
      createComposer(TYPED_DRAFT);
    const options = createOptions({ clearComposerAfterQueue, clearComposerIfUnchanged });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(
        resultRef.current?.submitMessage({
          message: UNDO_REQUEST,
          editorState: null,
          metadata: { undoTargetMessageId: "2ee0ad74-1111-2222-3333-444455556666" },
        }),
      ).resolves.toBe(false);
    });

    // The undo request itself did reach the durable queue...
    expect(options.enqueueServerSendQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        message: UNDO_REQUEST,
        metadata: expect.objectContaining({
          undoTargetMessageId: "2ee0ad74-1111-2222-3333-444455556666",
        }),
      }),
    );
    // ...and the user's unrelated draft survived it.
    expect(composer.draft).toBe(TYPED_DRAFT);
    expect(clearComposerAfterQueue).toHaveBeenCalledWith("conversation-local", UNDO_REQUEST);
  });

  it("propagates upload rejection without consuming the pending browser target", async () => {
    const options = createOptions({
      isAssistantTyping: false,
      imageFiles: [new File(["image"], "photo.png", { type: "image/png" })],
      performSubmit: vi.fn(async () => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => root.render(<Harness options={options} resultRef={resultRef} />));
    await act(async () => { await expect(resultRef.current!.submitMessage()).resolves.toBe(false); });
    expect(options.performSubmit).toHaveBeenCalledOnce();
    expect(options.clearPendingBrowserLaunchMode).not.toHaveBeenCalled();
    expect(options.clearComposerAfterQueue).not.toHaveBeenCalled();
  });

  it("still clears the composer when the queued message is the user's own draft", async () => {
    const { composer, clearComposerAfterQueue, clearComposerIfUnchanged } =
      createComposer(TYPED_DRAFT);
    const options = createOptions({ clearComposerAfterQueue, clearComposerIfUnchanged });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(resultRef.current?.submitMessage()).resolves.toBe(false);
    });

    expect(options.enqueueServerSendQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({ message: TYPED_DRAFT }),
    );
    expect(composer.draft).toBe("");
    expect(clearComposerAfterQueue).toHaveBeenCalledWith("conversation-local", TYPED_DRAFT);
  });

  it("forwards selected people into the durable queue before a busy assistant finishes", async () => {
    const composer = queuedMentionComposer();
    const options = createOptions({ inputValue: composer.message, inputEditorState: composer.editorState });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => root.render(<Harness options={options} resultRef={resultRef} />));
    await act(async () => { await resultRef.current?.submitMessage(); });
    expect(options.enqueueServerSendQueueItem).toHaveBeenCalledWith(expect.objectContaining({
      composerMessage: composer.message, editorState: composer.editorState,
      metadata: expect.objectContaining({ mentionedUserIds: [QUEUED_MENTION_USER_ID] }),
    }));
    expect(options.performSubmit).not.toHaveBeenCalled();
  });

  it.each(["queue", "steer"] as const)("preserves editor identity in explicit %s requests", async (intent) => {
    const composer = queuedMentionComposer();
    const options = createOptions({ inputValue: composer.message, inputEditorState: composer.editorState });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => root.render(<Harness options={options} resultRef={resultRef} />));
    await act(async () => { await resultRef.current?.submitMessage(undefined, { intent }); });
    const request = vi.mocked(options.submitSendIntent).mock.calls[0][0].request;
    const restored = readQueuedComposerMetadata(request.metadata as Record<string, unknown>, request.promptText as string);
    expect(restored.composer?.editorState).toBe(composer.editorState);
    expect(restored.metadata?.mentionedUserIds).toEqual([QUEUED_MENTION_USER_ID]);
  });

  it("keeps the composer intact when more than 32 people are selected", async () => {
    const options = createOptions({ inputEditorState: JSON.stringify({ root: { children: Array.from({ length: 33 }, (_, i) => ({ type: "user-mention", userId: `${i.toString(16).padStart(8, "0")}-bbbb-4ccc-8ddd-eeeeeeeeeeee`, handle: `person${i}` })) } }) });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => root.render(<Harness options={options} resultRef={resultRef} />));
    await act(async () => { await resultRef.current?.submitMessage(); });
    expect(options.showStatus).toHaveBeenCalledWith("Mention up to 32 people in one message.", "error", 4500);
    expect(options.enqueueServerSendQueueItem).not.toHaveBeenCalled();
    expect(options.clearComposerAfterQueue).not.toHaveBeenCalled();
    expect(options.clearComposerIfUnchanged).not.toHaveBeenCalled();
  });

  it("keeps the typed draft when a programmatic send falls back to the local queue", async () => {
    // Same guarantee on the localStorage fallback path, which is what runs when
    // the controller send queue is unavailable.
    const { composer, clearComposerAfterQueue, clearComposerIfUnchanged } =
      createComposer(TYPED_DRAFT);
    const options = createOptions({
      clearComposerAfterQueue,
      clearComposerIfUnchanged,
      enqueueServerSendQueueItem: vi.fn(async () => false),
    });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(
        resultRef.current?.submitMessage({ message: UNDO_REQUEST, editorState: null }),
      ).resolves.toBe(false);
    });

    expect(options.enqueueChatSendQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({ message: UNDO_REQUEST }),
    );
    expect(composer.draft).toBe(TYPED_DRAFT);
  });

  it("keeps the typed draft when an explicit Queue send carries its own text", async () => {
    // The Queue/Steer intent branch clears through the same helper, so it needs
    // the same guarantee.
    const { composer, clearComposerAfterQueue, clearComposerIfUnchanged } =
      createComposer(TYPED_DRAFT);
    const options = createOptions({ clearComposerAfterQueue, clearComposerIfUnchanged });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });

    await act(async () => {
      await expect(
        resultRef.current?.submitMessage(
          { message: UNDO_REQUEST, editorState: null },
          { intent: "queue" },
        ),
      ).resolves.toBe(true);
    });

    expect(options.submitSendIntent).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "queue" }),
    );
    expect(composer.draft).toBe(TYPED_DRAFT);
  });
});
