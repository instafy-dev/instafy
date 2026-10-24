/** @vitest-environment jsdom */

// On the narrow Studio's Browser tab the composer sends browser tasks to the
// browser's own machine. A browser that came back with its machine starts on a
// blank tab, which used to refuse every send ("Open a page in the browser...")
// although the agent can drive that tab.

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import type { BrowserSessionPage } from "../browserSessionPages";
import { useChatSubmitFlow } from "../useChatSubmitFlow";

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

const DRAFT = "Open the invoice list on example.com";
const RUNTIME_ID = "rt-space-machine";

const LIVE_PAGE: BrowserSessionPage = {
  id: "PAGE_TARGET_INVOICES",
  url: "https://app.example.com/invoices",
  host: "app.example.com",
  label: "Invoices",
  title: "Invoices",
  lastReferencedAt: 1,
  isActive: true,
};

const BLANK_TAB: BrowserSessionPage = {
  id: "PAGE_TARGET_BLANK",
  url: "about:blank",
  host: "",
  label: "New tab",
  title: null,
  lastReferencedAt: 2,
  isActive: true,
};

function readyEntry(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: RUNTIME_ID,
    status: "ready",
    health: "online",
    lastSeenAt: new Date().toISOString(),
    idleTtlSeconds: 900,
    ...overrides,
  };
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
  return {
    activeConversationEntry: {
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      visibility: "public",
    },
    activeConversationId: "conversation-local",
    activeConversationMessages: [],
    activeOrgId: null,
    activeProjectId: "project-1",
    appendMessages: vi.fn(),
    broadcastTyping: vi.fn(),
    clearComposerAfterQueue: vi.fn(),
    clearComposerIfUnchanged: vi.fn(),
    clearPendingBrowserLaunchMode: vi.fn(),
    createConversation: vi.fn(() => ({ localId: "conversation-local" })),
    createOrgInvitation: vi.fn(),
    credentialsReady: true,
    currentUserId: "user-1",
    effectiveRuntimeId: RUNTIME_ID,
    enqueueChatSendQueueItem: vi.fn(),
    enqueueServerSendQueueItem: vi.fn(async () => true),
    fetchRuntimeStatus: vi.fn(async () => ({ runtimes: [readyEntry()] }) as never),
    focusInput: vi.fn(),
    hasHiddenBrowserSession: false,
    browserSessionOpen: true,
    humanPeerContext: null,
    imageFiles: [],
    isAssistantTyping: false,
    inputEditorState: null,
    inputValue: DRAFT,
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
    personalBrowserAgentPhase: "idle",
    personalBrowserAgentSurfaceReady: false,
    personalBrowserRetryAgentControl: vi.fn(),
    personalBrowserRuntimeOverride: null,
    personalBrowserSetAgentControlEnabled: vi.fn(),
    // A browser that just started has only its blank tab: no real page to aim
    // at, so the composer's targeting offers the blank tab as the binding page.
    preferredBrowserPage: null,
    preferredRuntimeId: RUNTIME_ID,
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
    // The composer belongs to the browser shown on the Browser tab.
    sharedBrowserActive: true,
    sharedBrowserBindingPage: BLANK_TAB,
    sharedBrowserRuntimeId: RUNTIME_ID,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    shouldAutoScrollRef: { current: false },
    softPrefillSuggestion: null,
    submitSendIntent: vi.fn(async () => true),
    targetsOverlapActiveRuns: vi.fn(() => false),
    ...overrides,
  };
}

describe("useChatSubmitFlow on the Browser tab with only a blank tab", () => {
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
    intent: "send" | "queue" = "send",
  ): Promise<boolean | undefined> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    let sent: boolean | undefined;
    await act(async () => {
      // The Send button and Enter both end in this call with no override.
      sent = await resultRef.current?.submitMessage(undefined, {
        intent,
        expectedActiveJobId: null,
      });
    });
    return sent;
  }

  function statusMessages(options: HookOptions): string[] {
    return (options.showStatus as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0]),
    );
  }

  it("sends the task bound to the blank tab and keeps the person's own words", async () => {
    const options = createOptions();
    expect(await submit(options)).toBe(true);
    expect(statusMessages(options)).toEqual([]);
    expect(options.performSubmit).toHaveBeenCalledTimes(1);
    const payload = (options.performSubmit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.message).toBe(DRAFT);
    expect(payload.message).not.toContain("about:blank");
    expect(payload.message).not.toContain("New tab");
    expect(payload.runtimeOverride).toEqual(
      expect.objectContaining({ runtimeId: RUNTIME_ID, preferRuntime: true }),
    );
    expect(payload.metadata).toEqual(
      expect.objectContaining({
        browserTransport: "shared",
        browserRuntimeId: RUNTIME_ID,
        browserPageId: BLANK_TAB.id,
      }),
    );
  });

  it("queues the task bound to the blank tab", async () => {
    const options = createOptions();
    expect(await submit(options, "queue")).toBe(true);
    expect(options.submitSendIntent).toHaveBeenCalledTimes(1);
    const { request } = (options.submitSendIntent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.promptText).toBe(DRAFT);
    expect(request.metadata).toEqual(
      expect.objectContaining({ browserTransport: "shared", browserPageId: BLANK_TAB.id }),
    );
  });

  it("aims at a real page over the blank tab", async () => {
    const options = createOptions({
      preferredBrowserPage: LIVE_PAGE,
      sharedBrowserBindingPage: LIVE_PAGE,
    });
    expect(await submit(options)).toBe(true);
    const payload = (options.performSubmit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.metadata).toEqual(
      expect.objectContaining({ browserPageId: LIVE_PAGE.id, browserPageUrl: LIVE_PAGE.url }),
    );
  });

  it("still keeps the draft when the browser has no tab at all", async () => {
    const options = createOptions({ sharedBrowserBindingPage: null });
    expect(await submit(options)).toBe(false);
    expect(options.performSubmit).not.toHaveBeenCalled();
    expect(options.clearComposerIfUnchanged).not.toHaveBeenCalled();
    expect(statusMessages(options)).toEqual([
      "Open a page in the browser before sending a browser task. Your message is kept.",
    ]);
  });

  it("still waits for the browser runtime before using the blank tab", async () => {
    const options = createOptions({ sharedBrowserRuntimeId: null });
    expect(await submit(options)).toBe(false);
    expect(options.performSubmit).not.toHaveBeenCalled();
    expect(statusMessages(options)).toEqual([
      "Shared Browser agent control is still connecting. Wait for the browser to be ready before sending this task.",
    ]);
  });

  it("still waits for a ready browser machine before using the blank tab", async () => {
    const options = createOptions({
      fetchRuntimeStatus: vi.fn(async () =>
        ({ runtimes: [readyEntry({ status: "starting", health: "offline" })] }) as never,
      ),
    });
    expect(await submit(options)).toBe(false);
    expect(options.performSubmit).not.toHaveBeenCalled();
    expect(statusMessages(options)).toEqual([
      "Shared Browser is visible, but its agent runtime isn't ready yet. Wait for it to come up before sending this task.",
    ]);
  });

  it("makes the caller pass the tab a task binds to", () => {
    // ChatPanel passing this is what lets a task use the blank tab. Leaving it
    // out must fail to compile, or the Browser tab refuses every task again.
    const { sharedBrowserBindingPage, ...withoutBindingPage } = createOptions();
    expect(sharedBrowserBindingPage).toEqual(BLANK_TAB);
    // @ts-expect-error sharedBrowserBindingPage is required
    const incomplete: HookOptions = withoutBindingPage;
    expect(incomplete).not.toHaveProperty("sharedBrowserBindingPage");
  });

  it("leaves a Chat-tab send off the browser even with a blank tab open", async () => {
    const options = createOptions({ sharedBrowserActive: false });
    expect(await submit(options)).toBe(true);
    const payload = (options.performSubmit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.runtimeOverride).toBeNull();
    expect(payload.metadata).not.toHaveProperty("browserPageId");
    expect(payload.metadata).not.toHaveProperty("browserTransport");
  });
});
