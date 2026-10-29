/** @vitest-environment jsdom */

import { act, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../services/runtimeController/jobs", () => ({
  cancelAgentJob: vi.fn(), cancelConversationJobs: vi.fn(), cancelPlanGroup: vi.fn(),
}));

import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import type { ChatMessage } from "../../types";
import { isSkillSetupConversation } from "../skillSetupConversation";
import {
  BROWSER_HUMAN_INPUT_CONTINUE_PROMPT,
  useBrowserHumanInput,
  type BrowserHumanInputRequest,
} from "../useBrowserHumanInput";
import { useChatBrowserHandoff } from "../useChatBrowserHandoff";
import { useChatBrowserRequest } from "../useChatBrowserRequest";
import { useChatSubmitFlow } from "../useChatSubmitFlow";

// A skill setup offers a request_browser card that walks to the provider's
// screen. The walk stops at the provider's sign-in for the person and again on
// the screen that lists the value. Meanwhile the person answers the setup in
// chat, and those answers must go out as chat turns even while the browser is
// shown (a browser turn runs without the workspace's values and starts from a
// page snapshot). The walk goes on only through the browser's own controls.
// The harness wires the hooks the way ChatPanel does.

type SubmitOptions = Parameters<typeof useChatSubmitFlow>[0];
type HandoffOptions = Parameters<typeof useChatBrowserHandoff>[0];
type Controls = {
  submit: ReturnType<typeof useChatSubmitFlow>;
  signIn: ReturnType<typeof useBrowserHumanInput>;
};

const OCTO: ResolvedPromptAgentSelection = {
  activeHandles: ["octo"],
  explicitMentionedHandles: [],
  mentionedHandles: [],
  targetHandles: ["octo"],
  nextStickyMentionedAgent: null,
  usesDefaultAssistantOnly: true,
};
const TASK = "Open https://app.example.test and take me to Settings, then Connected apps. Pause for me to sign in myself.";
const PAGE = { id: "page-1", url: "https://app.example.test/apps", host: "app.example.test",
  label: "Connected apps", title: "Connected apps", lastReferencedAt: 1, isActive: true };
// Both read like browser instructions ("page", "tab"), which ordinary chats
// aim at the open page.
const SIGNED_IN_REPLY = "I signed in, the page shows my dashboard";
const COPIED_REPLY = "I copied both values from that page in my own tab";
const PERSONAL = { ownerId: null, status: null, runtimeOverride: null } as unknown as HandoffOptions["personal"];

function conversation(opener: string): ChatMessage[] {
  return [
    { id: "opener", role: "user", content: opener, timestamp: 1 },
    { id: "kickoff-reply", role: "assistant", content: "Two values are needed.", timestamp: 2 },
    { id: "browser-card", role: "assistant", content: "Continue this task in your browser.", timestamp: 3,
      metadata: { messageType: "action_request", details: { browserRequest: { task: TASK, location: "auto" } } } },
  ];
}

function signInPause(): BrowserHumanInputRequest {
  return { version: 1, handoffId: "sign-in", origin: "https://app.example.test", createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000, fields: [{ label: "Email" }, { label: "Password" }] };
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
    inputValue: "",
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
    sharedBrowserBindingPage: null,
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
  input: string;
  humanInput: BrowserHumanInputRequest | null;
  performSubmit: SubmitOptions["performSubmit"];
  onSubmit: HandoffOptions["onSubmit"];
  controlsRef: MutableRefObject<Controls | null>;
};

function Harness({ messages, busy, input, humanInput, performSubmit, onSubmit, controlsRef }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<"chat" | "browser">("chat");
  const handoff = useChatBrowserHandoff({
    userId: "user-1", projectId: "project-1", conversationId: "conversation-local", transport: "shared", open,
    canWrite: true, runtimeId: open ? "shared-runtime" : null, page: open ? PAGE : null, runs: [],
    personal: PERSONAL, agentHandle: "octo", onSubmit,
  });
  useChatBrowserRequest({
    identity: "user/project/conversation", messages, canWrite: true, ready: true, transport: "shared",
    open, busy, personalAvailable: false, personalReady: false, sharedReady: open, sharedUnavailable: false,
    activate: () => { setOpen(true); setSurface("browser"); },
    continueTask: (transport, message) => transport === "shared" ? handoff.continueShared(message) : Promise.resolve(false),
    onError: vi.fn(),
  });
  // The Shared Browser's Let Octo continue (BrowserSessionModal) is wired to the
  // same handoff as the card.
  const signIn = useBrowserHumanInput({
    identityKey: handoff.identityKey, request: humanInput, canTakeOver: false, humanControlConfirmed: true,
    onTakeOver: async () => true, onContinue: handoff.continueShared,
  });
  const submit = useChatSubmitFlow(submitOptions({
    activeConversationMessages: messages, browserSessionOpen: open, inputValue: input, isAssistantTyping: busy,
    preferredBrowserPage: open ? PAGE : null, performSubmit,
    // The browser is shown beside the composer, as ChatPanel's
    // browserComposerActive has it before a skill setup is considered.
    sharedBrowserActive: open && surface === "browser",
    skillSetupConversation: isSkillSetupConversation({ messages, olderMessagesUnloaded: false, title: null }),
  }));
  controlsRef.current = { submit, signIn };
  return <div data-testid="surface">{surface}</div>;
}

describe("a skill setup's browser walk", () => {
  let container: HTMLDivElement;
  let root: Root;
  const controlsRef: MutableRefObject<Controls | null> = { current: null };

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

  async function walk(messages: ChatMessage[]) {
    const performSubmit = vi.fn<SubmitOptions["performSubmit"]>(async () => true);
    const onSubmit = vi.fn<HandoffOptions["onSubmit"]>(async () => undefined);
    let state = { busy: false, input: "", humanInput: null as BrowserHumanInputRequest | null };
    const render = (next: Partial<typeof state>) => act(async () => {
      state = { ...state, ...next };
      root.render(<Harness messages={messages} {...state} performSubmit={performSubmit} onSubmit={onSubmit}
        controlsRef={controlsRef} />);
    });
    const reply = async (input: string) => {
      await render({ input });
      const before = performSubmit.mock.calls.length;
      await act(async () => { await expect(controlsRef.current!.submit.submitMessage()).resolves.toBe(true); });
      expect(performSubmit).toHaveBeenCalledTimes(before + 1);
      return performSubmit.mock.calls[before][0];
    };

    await render({});
    // The card's button starts the walk in the browser.
    const detail: { messageId: string; completion?: Promise<unknown> } = { messageId: "browser-card" };
    await act(async () => { window.dispatchEvent(new CustomEvent("instafy:request-browser", { detail })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await expect(detail.completion).resolves.toBeUndefined();
    // The walk runs and pauses at the provider's sign-in for the person.
    await render({ busy: true });
    await render({ busy: false, humanInput: signInPause() });
    const afterPause = { surface: container.textContent, reply: await reply(SIGNED_IN_REPLY) };
    // The person signs in on the page and chooses Let Octo continue.
    await act(async () => { await controlsRef.current!.signIn.continueTask(); });
    await render({ humanInput: null, busy: true });
    await render({ busy: false });
    const afterWalk = { surface: container.textContent, reply: await reply(COPIED_REPLY) };
    return { onSubmit, afterPause, afterWalk };
  }

  it("sends the setup's replies as chat turns and continues the walk only through the browser", async () => {
    const { onSubmit, afterPause, afterWalk } = await walk(conversation("/skills import https://github.com/acme/skills --start"));

    // The walk itself: the card's press, then Let Octo continue after sign-in.
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0][1]).toContain(TASK);
    expect(onSubmit.mock.calls[1][1]).toBe(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT);
    for (const [, , options] of onSubmit.mock.calls) {
      expect(options?.metadata).toMatchObject({ browserTransport: "shared", browserRuntimeId: "shared-runtime" });
    }

    // The browser stays shown for the sign-in, and replies are chat turns.
    for (const [after, text] of [[afterPause, SIGNED_IN_REPLY], [afterWalk, COPIED_REPLY]] as const) {
      expect(after.surface).toBe("browser");
      expect(after.reply.message).toBe(text);
      expect(after.reply.metadata).not.toHaveProperty("browserTransport");
      expect(after.reply.metadata).not.toHaveProperty("browserRuntimeId");
      expect(after.reply.runtimeOverride ?? null).toBeNull();
    }
  });

  it("keeps an ordinary chat's browser composer", async () => {
    const { afterPause, afterWalk } = await walk(conversation("Compare the two plans on their pricing pages"));
    for (const after of [afterPause, afterWalk]) {
      expect(after.reply.metadata).toMatchObject({ browserTransport: "shared", browserRuntimeId: "shared-runtime" });
      // The person's own words: the page goes as the turn's bound tab.
      expect(after.reply.message).not.toContain("Use the existing");
    }
  });
});
