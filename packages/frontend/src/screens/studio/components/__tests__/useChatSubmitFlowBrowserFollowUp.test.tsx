/** @vitest-environment jsdom */

// A local test, Oct 31: for ten minutes after a browser turn, every message
// from the chat composer went to the browser, whose turn cannot build. "Put
// the hours and the metro route on a small page I can share." was refused as
// "read-only". A message from the chat composer is an ordinary turn now,
// whatever came before it: the routing step decides whether it goes to the
// browser, and a card it sends there goes on from the browser turn before it
// (sharedBrowserFollowUp, from ChatPanel).

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import { toBrowserSessionPageTarget, type BrowserSessionPage } from "../browserSessionPages";
import { BROWSER_CONTINUES_RUN_METADATA_KEY } from "../useChatBrowserHandoff";
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

const DRAFT = "Now find how to get there by metro from the main station.";
const RUNTIME_ID = "rt-space-machine";

// The tab the browser turn worked in.
const RUN_TAB: BrowserSessionPage = {
  id: "PAGE_TARGET_TOWER",
  url: "https://www.example.org/places/tower",
  host: "www.example.org",
  label: "Tower",
  title: "Tower",
  lastReferencedAt: 1,
  isActive: false,
};

// Another tab, in front now.
const OTHER_TAB: BrowserSessionPage = {
  id: "PAGE_TARGET_OTHER",
  url: "https://other.example.net/",
  host: "other.example.net",
  label: "Other",
  title: "Other",
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
    preferredBrowserPage: OTHER_TAB,
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
    // The composer is the chat's, beside a browser that is open.
    sharedBrowserActive: false,
    sharedBrowserBindingPage: OTHER_TAB,
    sharedBrowserRuntimeId: RUNTIME_ID,
    showCredentialsGate: vi.fn(),
    showStatus: vi.fn(),
    shouldAutoScrollRef: { current: false },
    submitSendIntent: vi.fn(async () => true),
    targetsOverlapActiveRuns: vi.fn(() => false),
    ...overrides,
  };
}

describe("a message from the chat right after a browser turn", () => {
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

  async function submit(options: HookOptions): Promise<boolean | undefined> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await resultRef.current?.submitMessage(undefined, {
        intent: "send",
        expectedActiveJobId: null,
      });
    });
    return sent;
  }

  function payload(options: HookOptions) {
    return (options.performSubmit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
  }

  it.each([
    "Put the hours and the metro route on a small page I can share.",
    DRAFT,
    "keep going",
  ])("goes out as an ordinary turn in the person's own words: %s", async (words) => {
    const resolveSharedBrowserTab = vi.fn(async () => toBrowserSessionPageTarget(RUN_TAB));
    const options = createOptions({ inputValue: words, resolveSharedBrowserTab });
    expect(await submit(options)).toBe(true);
    const sent = payload(options);
    expect(sent.message).toBe(words);
    expect(sent.runtimeOverride).toBeNull();
    for (const key of ["browserTransport", "browserPageId", BROWSER_CONTINUES_RUN_METADATA_KEY]) {
      expect(sent.metadata ?? {}).not.toHaveProperty(key);
    }
    expect(resolveSharedBrowserTab).not.toHaveBeenCalled();
  });

  it("leaves the browser's own composer as it was: a browser turn in the chat's own tab", async () => {
    const resolveSharedBrowserTab = vi.fn(async () => toBrowserSessionPageTarget(RUN_TAB));
    const options = createOptions({ sharedBrowserActive: true, resolveSharedBrowserTab });
    expect(await submit(options)).toBe(true);
    const sent = payload(options);
    expect(sent.runtimeOverride).toEqual(expect.objectContaining({ runtimeId: RUNTIME_ID, preferRuntime: true }));
    expect(sent.metadata).toEqual(expect.objectContaining({ browserTransport: "shared", browserPageId: RUN_TAB.id }));
    expect(sent.metadata).not.toHaveProperty(BROWSER_CONTINUES_RUN_METADATA_KEY);
  });
});
