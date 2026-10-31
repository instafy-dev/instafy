// @vitest-environment jsdom
//
// Local test, Oct 31: while a form chat's browser turn asked "Octo wants to
// open httpbin.org/forms/post. [Deny] [Allow]", the same prompt showed in the
// Browser view of two other chats of the same person, over "Octo is working in
// another chat", and their Browser tab read "Approve". The view read the
// prompt of the tab in front, whichever chat's it was, so an answer there
// would have settled the form chat's step. A chat's view now shows and
// answers only its own chat's prompts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, Profiler, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { BrowserSessionPage } from "../browserSessionPages";

type Prompt = { runtimeId: string; request: { approvalId: string; browserPageId: string } & Record<string, unknown> };
const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  requestAccessToken: vi.fn(),
  /** The prompt waiting at the origin: one per person, bound to its run's tab. */
  waiting: null as Prompt | null,
  /** The tabs whose prompt was read, in order. */
  reads: [] as string[],
  decisions: [] as Array<{ approvalId: string; decision: string }>,
  instances: [] as Array<{ canvas: HTMLCanvasElement; listeners: Record<string, () => void> }>,
}));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: {
  core: { enabled: true, baseUrl: "" },
  runtimes: { fetchStatus: mocks.fetchStatus, ensure: vi.fn(), stop: vi.fn(), stopIfIdle: vi.fn() },
  browserProfiles: { clearForProject: vi.fn() },
  browserSessions: {
    fetchHost: vi.fn(), startHost: vi.fn(), isUnavailableError: () => false, isHostRefusedError: () => false,
    // The origin keeps a prompt for the person who started the run and the
    // tab it is bound to, and gives it to a read of that tab from any of
    // their chats; a read of another tab gets none.
    fetchPendingApproval: async ({ browserPageId }: { browserPageId: string }) => {
      mocks.reads.push(browserPageId);
      const waiting = mocks.waiting;
      return waiting && waiting.request.browserPageId === browserPageId ? waiting : null;
    },
    decideApproval: async ({ pending, decision }: { pending: Prompt; decision: string }) => {
      if (mocks.waiting?.request.approvalId !== pending.request.approvalId) return false;
      mocks.decisions.push({ approvalId: pending.request.approvalId, decision });
      mocks.waiting = null;
      return true;
    },
  },
  workspace: { origin: { requestAccessToken: mocks.requestAccessToken,
    requestAccessTokenResult: async (params: unknown) => ({ ok: true, token: await mocks.requestAccessToken(params) }),
  } },
} }));
vi.mock("../SharedBrowserProfileStatus", () => ({ SharedBrowserProfileStatus: () => null }));
vi.mock("../useBrowserSessionActions", () => ({ useBrowserSessionActions: () => ({ actions: [], latestClick: null }) }));
vi.mock("../useSharedBrowserCollaboration", () => ({ useSharedBrowserCollaboration: ({ active }: { active: boolean }) => ({
  client: { connectionStatus: active ? "connected" : "idle", participantId: active ? "self" : null,
    state: active ? { revision: 1, participants: [], requests: [], controlOwner: { kind: "human", participantId: "self" } } : null,
    error: null },
  publishCursor: () => {}, requestControl: () => {}, takeControl: () => {}, releaseControl: () => {}, grantControl: () => {},
}) }));
vi.mock("@novnc/novnc/lib/rfb", () => ({ default: class {
  canvas: HTMLCanvasElement;
  get _canvas() { return this.canvas; }
  background = "";
  listeners: Record<string, () => void> = {};
  viewOnly = false;
  disconnect = vi.fn(() => this.canvas.remove());
  addEventListener(type: string, listener: () => void) { this.listeners[type] = listener; }
  constructor(container: HTMLDivElement) {
    this.canvas = document.createElement("canvas");
    container.append(this.canvas); mocks.instances.push(this);
  }
} }));
import { BrowserApprovalRow } from "../BrowserApprovalRow";
import { BrowserSessionModal } from "../BrowserSessionModal";
import { useChatSharedBrowserApproval, useChatViewApprovalPending } from "../useChatSharedBrowserApproval";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userId = "55555555-5555-4555-8555-555555555555";
const formRunId = "44444444-4444-4444-8444-444444444444";
const approvalId = "22222222-2222-4222-8222-222222222222";
const browserSessionId = "browser-surface-1";
const session = { runtimeId, status: "ready", provider: "instafy-cloud", displayName: "Browser session", health: "idle", lastSeenAt: null,
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } };
const noop = () => {};

/** Each chat's own tab in the one browser of the space. */
const TABS = {
  lello: { id: "PAGE-LELLO", url: "https://www.metrodoporto.pt/pages/285" },
  github: { id: "PAGE-GITHUB", url: "https://github.com/login" },
  form: { id: "PAGE-FORM", url: "https://httpbin.org/forms/post" },
} as const;
type ChatId = keyof typeof TABS;

function tabs(front: ChatId): BrowserSessionPage[] {
  return (Object.keys(TABS) as ChatId[]).map((chat) => {
    const { id, url } = TABS[chat];
    const host = new URL(url).host;
    return { id, url, host, label: host, title: host, lastReferencedAt: 0, isActive: chat === front };
  });
}

/** The form chat's running browser job, bound to its own tab. */
function formRun(): RunRecord {
  return {
    id: formRunId, projectId, sessionId: null, conversationId: "form", promptId: null, runType: "prompt", status: "in_progress",
    progress: 0, progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
    metadata: { browserTransport: "shared", initiatingUserId: userId, browserRuntimeId: runtimeId, browserPageId: TABS.form.id },
  } as RunRecord;
}

/** Its site prompt, as the origin keeps it for the person who started the run. */
function sitePrompt(): Prompt {
  return { runtimeId, request: {
    version: 1, approvalId, kind: "origin", ownerId: "33333333-3333-4333-8333-333333333333", runId: formRunId,
    initiatorUserId: userId, browserPageId: TABS.form.id, operation: "approve-origin", sourceOrigin: null,
    destinationOrigin: "https://httpbin.org", destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null,
    payloadFingerprint: null, requestedAtMs: Date.now(), expiresAtMs: Date.now() + 120_000, requestFingerprint: "e".repeat(64),
    display: { label: "Open https://httpbin.org/forms/post", destinationOrigin: "https://httpbin.org" },
  } };
}

type StudioProps = {
  /** The chat on screen. ChatPanel keeps one Browser view and switches it from chat to chat. */
  chat: ChatId;
  /** The tab the browser has in front. */
  front: ChatId;
  /** A browser turn of another chat holds the browser. */
  anotherChatTurn: boolean;
  /** The chat's running jobs. */
  runs: RunRecord[];
  /** The Browser view is on screen; otherwise Chat is, and the view stays mounted behind it. */
  browserShown?: boolean;
  /** A phone: one row of chrome, the prompt as a sheet at the bottom. */
  phone?: boolean;
};

/**
 * ChatPanel's part, as its source wires it (checked below): the chat's own
 * prompt lane for its running browser job, the row it feeds, the Browser view,
 * and the Browser tab's "Approve" from either.
 */
function Studio({ chat, front, anotherChatTurn, runs, browserShown = true, phone = false }: StudioProps) {
  const chatBrowserApproval = useChatSharedBrowserApproval({ enabled: true, projectId, userId, runs, browserSessionId });
  const chatViewApproval = useChatViewApprovalPending(chat);
  const sharedBrowserApprovalPending = chatViewApproval.pending;
  const chatBrowserApprovalTarget = chatBrowserApproval.target;
  const chatBrowserApprovalAsking = chatBrowserApproval.approval.pending !== null;
  const browserRunApproval = useMemo(
    () => chatBrowserApprovalTarget
      ? { runtimeId: chatBrowserApprovalTarget.runtimeId, approval: chatBrowserApproval.approval }
      : null,
    [chatBrowserApproval.approval, chatBrowserApprovalTarget],
  );
  const browserApprovalAttention = sharedBrowserApprovalPending || chatBrowserApprovalAsking;
  return (
    <>
      <button type="button" data-testid="browser-tab">Browser{browserApprovalAttention ? <span>Approve</span> : null}</button>
      {chatBrowserApprovalTarget ? <BrowserApprovalRow agentDisplayName="Octo" approval={chatBrowserApproval.approval} /> : null}
      <BrowserSessionModal isOpen transportActive={browserShown} onOpenChange={noop} projectId={projectId} currentUserId={userId}
        browserSessionId={browserSessionId} preferRuntimeId={null} resumeRuntimeId={runtimeId}
        presentation="docked" fillContainer canControlBrowser canClearBrowserData spaceBusy
        sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
        sharedBrowserViewerKind="rfb" sharedBrowserAvailableViewerKinds={["rfb"]}
        sharedBrowserRfbCapabilities={{ renderScale: 1, maxFramebufferPixels: 8_294_400 }}
        onApprovalPendingChange={chatViewApproval.onApprovalPendingChange}
        runApproval={browserRunApproval}
        conversationId={chat}
        chatPageIds={[TABS[chat].id]}
        anotherChatTurn={anotherChatTurn}
        sharedBrowserChrome={{ pages: tabs(front), resolved: true, pendingAction: null, error: null, compact: phone,
          onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop }} />
    </>
  );
}

describe("a chat's Browser view and another chat's prompt", () => {
  let root: Root;
  let container: HTMLDivElement;
  /** What each commit put on the page, whichever part of Studio drew it. */
  let drawn: Array<{ prompt: boolean; approve: boolean }> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    mocks.waiting = null; mocks.reads = []; mocks.decisions = []; mocks.instances.length = 0; drawn = [];
    mocks.fetchStatus.mockReset().mockResolvedValue({ runtimes: [session] });
    mocks.requestAccessToken.mockReset().mockResolvedValue({ token: "origin-token", endpoint: "https://origin.test", expiresIn: 300 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,c3RpbGw=");
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(console, "log").mockImplementation(() => {});
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(50, ms - elapsed)); await vi.dynamicImportSettled(); });
    }
  }
  const viewPrompt = () => document.querySelector('[data-testid="shared-browser-approval-prompt"]');
  const row = () => document.querySelector('[data-testid="browser-approval-row"]');
  const tab = () => document.querySelector('[data-testid="browser-tab"]')!.textContent;
  const recordDraw = () => {
    drawn.push({ prompt: viewPrompt() !== null || row() !== null, approve: tab()?.includes("Approve") === true });
  };
  async function show(props: StudioProps) {
    await act(async () => root.render(<Profiler id="studio" onRender={recordDraw}><Studio {...props} /></Profiler>));
    await advance(3_000);
  }
  const note = () => document.querySelector('[data-testid="browser-session-agent-arrival"]')?.textContent ?? null;
  /** Escape, as the person presses it in the view: it denies the prompt that has focus. */
  async function pressEscape() {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  }

  it("shows another chat's prompt in no other chat's view, and lights only the asking chat's Approve", async () => {
    mocks.waiting = sitePrompt();
    // The Lello chat, Browser in front, while the form chat's step asks.
    await show({ chat: "lello", front: "form", anotherChatTurn: true, runs: [] });
    expect(note()).toBe("Octo is working in another chat");
    expect(viewPrompt()).toBeNull();
    expect(container.textContent).not.toContain("httpbin.org");
    expect(tab()).toBe("Browser");
    await pressEscape();
    expect(mocks.decisions).toEqual([]);
    // The GitHub chat, on a phone, where the prompt would be a sheet.
    await show({ chat: "github", front: "form", anotherChatTurn: true, runs: [], phone: true });
    expect(note()).toBe("Octo is working in another chat");
    expect(viewPrompt()).toBeNull();
    expect(container.textContent).not.toContain("httpbin.org");
    expect(tab()).toBe("Browser");
    // The Lello chat with Chat in front: its view stays mounted behind it.
    await show({ chat: "lello", front: "form", anotherChatTurn: true, runs: [], browserShown: false });
    expect(viewPrompt()).toBeNull();
    expect(container.textContent).not.toContain("httpbin.org");
    expect(tab()).toBe("Browser");
    // Neither view read the prompt of a tab that is not its chat's.
    expect(mocks.reads).toEqual([]);
    expect(mocks.decisions).toEqual([]);

    // The form chat itself: its row and its view both ask, and its tab says Approve.
    await show({ chat: "form", front: "form", anotherChatTurn: false, runs: [formRun()] });
    expect(row()?.textContent).toContain("Octo wants to open httpbin.org/forms/post.");
    expect(viewPrompt()?.textContent).toContain("Octo wants to open httpbin.org/forms/post.");
    expect(tab()).toBe("BrowserApprove");
    // One answer settles both.
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')!.click(); });
    await advance(500);
    expect(mocks.decisions).toEqual([{ approvalId, decision: "allow_origin" }]);
    expect(viewPrompt()).toBeNull();
    expect(row()).toBeNull();
    expect(tab()).toBe("Browser");
  });

  // The view says it shows a prompt only after it draws, and ChatPanel keeps
  // one view for every chat: the chat the person goes to never draws the
  // prompt, or Approve, of the chat they left, not even once.
  it.each([
    { asks: "in its own view, before its run's lane is up", runs: () => [] },
    { asks: "in its row and its view, from its run's lane", runs: () => [formRun()] },
  ])("leaves the asking chat's prompt and Approve behind when the person goes to another chat ($asks)", async ({ runs }) => {
    mocks.waiting = sitePrompt();
    await show({ chat: "form", front: "form", anotherChatTurn: false, runs: runs() });
    expect(viewPrompt()?.textContent).toContain("Octo wants to open httpbin.org/forms/post.");
    expect(tab()).toBe("BrowserApprove");
    // The person goes to the Lello chat while the step still asks.
    drawn = [];
    await show({ chat: "lello", front: "form", anotherChatTurn: true, runs: [] });
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((draw) => draw.prompt || draw.approve)).toEqual([]);
    expect(note()).toBe("Octo is working in another chat");
    await pressEscape();
    expect(mocks.decisions).toEqual([]);
    // Back in the form chat, it asks again.
    await show({ chat: "form", front: "form", anotherChatTurn: false, runs: runs() });
    expect(viewPrompt()?.textContent).toContain("Octo wants to open httpbin.org/forms/post.");
    expect(tab()).toBe("BrowserApprove");
  });

  it("still asks in the chat's own view before its run's own lane is up", async () => {
    mocks.waiting = sitePrompt();
    await show({ chat: "form", front: "form", anotherChatTurn: false, runs: [] });
    expect(viewPrompt()?.textContent).toContain("Octo wants to open httpbin.org/forms/post.");
    expect(tab()).toBe("BrowserApprove");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="shared-browser-approval-allow"]')!.click(); });
    await advance(500);
    expect(mocks.decisions).toEqual([{ approvalId, decision: "allow_origin" }]);
    expect(viewPrompt()).toBeNull();
    expect(tab()).toBe("Browser");
  });
});

/**
 * ChatPanel is wired to a dozen providers, so it is not mounted here (see
 * chatPanelChatBrowserView.test.ts): these read its source, so the Studio
 * harness above is wired as it is.
 */
describe("ChatPanel's Browser tab and view prompts", () => {
  const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
  const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

  it("lights Approve only from the chat's own lane and its view, kept with the chat it was for", () => {
    expect(chatPanel).toContain("const surfaceScope = conversationSurfaceScope(currentUserId, activeProjectId ?? null, activeConversationId);");
    expect(chatPanel).toContain("const chatViewApproval = useChatViewApprovalPending(surfaceScope);");
    expect(chatPanel).toContain("const sharedBrowserApprovalPending = chatViewApproval.pending;");
    expect(chatPanel).toContain("const chatBrowserApprovalAsking = chatBrowserApproval.approval.pending !== null;");
    expect(chatPanel).toContain("const browserApprovalAttention = sharedBrowserApprovalPending || chatBrowserApprovalAsking;");
    expect(chatPanel).toContain("attention: browserApprovalAttention,");
    expect(chatPanel).toContain("attention: browserApprovalAttention ? <span");
    expect(chatPanel).toContain("onApprovalPendingChange={chatViewApproval.onApprovalPendingChange}");
    // Nothing else sets whether the view shows a prompt.
    expect(chatPanel).not.toContain("setSharedBrowserApprovalPending");
  });

  it("gives the view the chat's own lane, tabs and other chats' turns", () => {
    const from = chatPanel.indexOf("const chatBrowserApproval = useChatSharedBrowserApproval({");
    expect(from).toBeGreaterThan(-1);
    expect(chatPanel.slice(from, chatPanel.indexOf("});", from))).toContain("runs: activeConversationRuns,");
    expect(chatPanel).toContain("runApproval={browserRunApproval}");
    expect(chatPanel).toContain("chatPageIds={chatViewPageIds}");
    expect(chatPanel).toContain("anotherChatTurn={anotherChatBrowserTurn}");
  });
});
