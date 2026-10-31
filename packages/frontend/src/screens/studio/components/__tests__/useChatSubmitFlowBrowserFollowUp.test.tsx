/** @vitest-environment jsdom */

// Local drive, Oct 28: after a browser turn answered "find the opening hours",
// "Now find how to get there by tram" from the chat composer started an
// ordinary turn that only sent another browser card. It took 13 s, a second
// press and a second approval for the same site, and left two live cards. A
// follow-up in a browser chat now goes straight to the open browser,
// continuing the run that just answered so its approvals carry over.

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPromptAgentSelection } from "../../../../conversations/assistantMentions";
import type { BrowserSessionPage } from "../browserSessionPages";
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

const DRAFT = "Now find how to get there by tram from the main square.";
const RUNTIME_ID = "rt-space-machine";
const BROWSER_RUN = "00000000-0000-4000-8000-0000000000b2";

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

describe("a follow-up in a browser chat", () => {
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

  async function submit(options: HookOptions, automatic = false): Promise<boolean | undefined> {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await resultRef.current?.submitMessage(undefined, {
        intent: "send",
        expectedActiveJobId: null,
        automatic,
      });
    });
    return sent;
  }

  function payload(options: HookOptions) {
    return (options.performSubmit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
  }

  const followUp = () => ({ runId: BROWSER_RUN, page: RUN_TAB });

  it("goes straight to the open browser, in the run's own tab, continuing that run", async () => {
    const options = createOptions({ resolveSharedBrowserFollowUp: vi.fn(followUp) });
    expect(await submit(options)).toBe(true);
    const sent = payload(options);
    // The person's own words, as a browser turn on the browser's machine.
    expect(sent.message).toBe(DRAFT);
    expect(sent.runtimeOverride).toEqual(expect.objectContaining({ runtimeId: RUNTIME_ID, preferRuntime: true }));
    expect(sent.metadata).toEqual(expect.objectContaining({
      browserTransport: "shared",
      browserRuntimeId: RUNTIME_ID,
      browserPageId: RUN_TAB.id,
      [BROWSER_CONTINUES_RUN_METADATA_KEY]: BROWSER_RUN,
    }));
  });

  it("aims words about the page at the run's tab, not the one in front", async () => {
    const options = createOptions({
      inputValue: "Click the menu button on that page",
      resolveSharedBrowserFollowUp: vi.fn(followUp),
    });
    expect(await submit(options)).toBe(true);
    const sent = payload(options);
    expect(sent.message).not.toContain(OTHER_TAB.url);
    expect(sent.metadata).toEqual(expect.objectContaining({ browserPageId: RUN_TAB.id, browserPageUrl: RUN_TAB.url }));
  });

  it("stays an ordinary chat turn when the last turn was not one in the browser", async () => {
    const options = createOptions({ resolveSharedBrowserFollowUp: vi.fn(() => null) });
    expect(await submit(options)).toBe(true);
    const sent = payload(options);
    expect(sent.runtimeOverride).toBeNull();
    expect(sent.metadata).not.toHaveProperty("browserTransport");
    expect(sent.metadata).not.toHaveProperty(BROWSER_CONTINUES_RUN_METADATA_KEY);
  });

  const cases: [string, Partial<HookOptions>, boolean][] = [
    ["a skill setup, whose replies answer the setup", { skillSetupConversation: true }, false],
    ["a message with a picture, which a browser turn cannot open", { imageFiles: [new File(["x"], "x.png")] }, false],
    ["a message for a new tab", { pendingBrowserLaunchMode: "new_page" }, false],
    ["a send the app makes for the person (an automatic retry)", {}, true],
  ];
  it.each(cases)("leaves %s to the chat", async (_name, overrides, automatic) => {
    const resolve = vi.fn(followUp);
    const options = createOptions({ ...overrides, resolveSharedBrowserFollowUp: resolve });
    await submit(options, automatic);
    expect(resolve).not.toHaveBeenCalled();
    const sent = payload(options);
    if (sent) expect(sent.metadata ?? {}).not.toHaveProperty(BROWSER_CONTINUES_RUN_METADATA_KEY);
  });

  it("leaves the browser's own composer as it was", async () => {
    const resolve = vi.fn(followUp);
    const options = createOptions({ sharedBrowserActive: true, resolveSharedBrowserFollowUp: resolve });
    expect(await submit(options)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(payload(options).metadata).toEqual(expect.objectContaining({ browserPageId: OTHER_TAB.id }));
  });
});
