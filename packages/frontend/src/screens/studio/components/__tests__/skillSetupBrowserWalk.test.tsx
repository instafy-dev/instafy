/** @vitest-environment jsdom */

import { act, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import type { ChatMessage } from "../../types";
import { useChatBrowserRequest } from "../useChatBrowserRequest";
import { useChatSubmitFlow } from "../useChatSubmitFlow";

// A skill setup offers a request_browser card that walks to the provider's
// screen. Once that walk is done, the person's next message answers the setup.
// It must go out as a chat turn, not as another bounded browser job (which
// runs without the workspace's values and starts from a page snapshot).
// ChatPanel routes the composer to the browser while the browser surface is
// shown (`browserComposerActive`); this harness keeps that same rule.

type SubmitOptions = Parameters<typeof useChatSubmitFlow>[0];
type SubmitResult = ReturnType<typeof useChatSubmitFlow>;

const OCTO: ResolvedPromptAgentSelection = {
  activeHandles: ["octo"],
  explicitMentionedHandles: [],
  mentionedHandles: [],
  targetHandles: ["octo"],
  nextStickyMentionedAgent: null,
  usesDefaultAssistantOnly: true,
};
const SETUP_REPLY = "I copied both values into the cards";
const PAGE = { id: "page-1", url: "https://app.example.test/apps", host: "app.example.test",
  label: "Connected apps", title: "Connected apps", lastReferencedAt: 1, isActive: true };

function card(): ChatMessage {
  return { id: "browser-card", role: "assistant", content: "Continue this task in your browser.", timestamp: 3,
    metadata: { messageType: "action_request", details: { browserRequest: {
      task: "Open https://app.example.test and take me to Settings, then Connected apps. I sign in myself.",
      location: "auto" } } } };
}

function conversation(opener: string): ChatMessage[] {
  return [
    { id: "opener", role: "user", content: opener, timestamp: 1 },
    { id: "kickoff-reply", role: "assistant", content: "Two values are needed.", timestamp: 2 },
    card(),
  ];
}

function submitOptions(overrides: Partial<SubmitOptions>): SubmitOptions {
  return {
    activeConversationEntry: { controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", visibility: "public" },
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
    effectiveRuntimeId: "shared-runtime",
    enqueueChatSendQueueItem: vi.fn(),
    enqueueServerSendQueueItem: vi.fn(async () => true),
    fetchRuntimeStatus: vi.fn(async () => ({
      preferredRuntimeId: "shared-runtime",
      runtimes: [{ runtimeId: "shared-runtime", status: "ready", provider: "hosted", idleTtlSeconds: 3600,
        isLocal: false, isPreferred: true, health: "online" as const }],
    })),
    focusInput: vi.fn(),
    hasHiddenBrowserSession: false,
    browserSessionOpen: false,
    humanPeerContext: { hasHumanPeer: false, resolved: true },
    imageFiles: [],
    isAssistantTyping: false,
    inputEditorState: null,
    inputValue: SETUP_REPLY,
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
    preferredRuntimeId: "shared-runtime",
    revealAiGatesForCurrentDraft: vi.fn(() => true),
    requestRuntimeRecovery: vi.fn(),
    resolveGroupParticipationBeforeSubmit: vi.fn(async ({ metadata }) => ({ mode: "dispatch" as const, metadata })),
    resolvePromptAgentTargets: vi.fn(() => OCTO),
    runtimeControllerEnabled: true,
    runtimeReady: true,
    scrollToBottom: vi.fn(),
    sendingAttachment: false,
    sharedBrowserActive: false,
    sharedBrowserRuntimeId: "shared-runtime",
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    shouldAutoScrollRef: { current: false },
    softPrefillSuggestion: null,
    submitSendIntent: vi.fn(async () => true),
    targetsOverlapActiveRuns: vi.fn(() => false),
    ...overrides,
  };
}

type HarnessProps = {
  messages: ChatMessage[];
  busy: boolean;
  performSubmit: SubmitOptions["performSubmit"];
  resultRef: MutableRefObject<SubmitResult | null>;
  continueTask: (transport: "personal" | "shared", message: string) => Promise<boolean>;
};

function Harness({ messages, busy, performSubmit, resultRef, continueTask }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<"chat" | "browser">("chat");
  useChatBrowserRequest({
    identity: "user/project/conversation", messages, canWrite: true, ready: true, transport: "shared",
    open, busy, personalAvailable: false, personalReady: false, sharedReady: true, sharedUnavailable: false,
    activate: () => { setOpen(true); setSurface("browser"); },
    continueTask,
    returnToChat: () => setSurface("chat"),
    onError: vi.fn(),
  });
  const browserComposerActive = open && surface === "browser";
  resultRef.current = useChatSubmitFlow(submitOptions({
    activeConversationMessages: messages, browserSessionOpen: open, isAssistantTyping: busy,
    preferredBrowserPage: open ? PAGE : null, performSubmit, sharedBrowserActive: browserComposerActive,
  }));
  return <div data-testid="surface">{surface}</div>;
}

describe("a skill setup's browser walk", () => {
  let container: HTMLDivElement;
  let root: Root;
  const resultRef: MutableRefObject<SubmitResult | null> = { current: null };

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function walkThenReply(messages: ChatMessage[]) {
    const performSubmit = vi.fn<SubmitOptions["performSubmit"]>(async () => true);
    const continueTask = vi.fn<HarnessProps["continueTask"]>(async () => true);
    const render = (busy: boolean) => act(async () => {
      root.render(<Harness messages={messages} busy={busy} performSubmit={performSubmit}
        resultRef={resultRef} continueTask={continueTask} />);
    });
    await render(false);
    const detail: { messageId: string; completion?: Promise<unknown> } = { messageId: "browser-card" };
    await act(async () => { window.dispatchEvent(new CustomEvent("instafy:request-browser", { detail })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await expect(detail.completion).resolves.toBeUndefined();
    expect(continueTask).toHaveBeenCalledExactlyOnceWith("shared", expect.stringContaining("Connected apps"));
    // The walk runs, then finishes.
    await render(true);
    expect(container.textContent).toBe("browser");
    await render(false);
    await act(async () => { await expect(resultRef.current!.submitMessage()).resolves.toBe(true); });
    return { surface: container.textContent, metadata: performSubmit.mock.calls[0][0].metadata };
  }

  it("sends the next setup reply as a chat turn", async () => {
    const after = await walkThenReply(conversation("/skills import https://github.com/acme/skills --start"));
    expect(after.surface).toBe("chat");
    expect(after.metadata).not.toHaveProperty("browserTransport");
    expect(after.metadata).not.toHaveProperty("browserRuntimeId");
  });

  it("keeps an ordinary chat's browser composer after its walk", async () => {
    const after = await walkThenReply(conversation("Compare the two plans on their pricing pages"));
    expect(after.surface).toBe("browser");
    expect(after.metadata).toMatchObject({ browserTransport: "shared", browserRuntimeId: "shared-runtime" });
  });
});
