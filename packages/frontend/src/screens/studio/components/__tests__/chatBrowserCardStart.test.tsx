// @vitest-environment jsdom
//
// Seen Oct 30: no browser card opened by itself while the person
// stayed in Chat. One sat on "Opening Instafy's browser" for two minutes,
// then said the browser "did not start in time", though it had started at
// once; the others waited until the person opened the chat's Browser view.
// The card waited for the page Take over acts on, which a chat with no tab
// yet has only while its Browser view is on screen. It now waits for a tab
// its turn can use: the chat's own, or a blank one it gets as it is sent.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { browserAutoStartPlan, forgetBrowserAutoStartsForTests, type BrowserAutoStartPlan } from "../browserAutoStart";
import type { BrowserSessionPage, BrowserSessionPageTarget } from "../browserSessionPages";
import {
  chatBrowserCardReady,
  chatBrowserTab,
  chatBrowserTarget,
  chatViewPageIds,
  CHAT_VIEW_TURN_TABS_START,
  forgetChatBrowserTabsForTests,
  useChatBrowserTab,
  type ChatBrowserTabScope,
} from "../chatBrowserTab";
import type { SharedBrowserHostReading } from "../useSharedBrowserHostSnapshot";
import { useChatBrowserRequest, type BrowserAutoStartOptions } from "../useChatBrowserRequest";

const HOST = "host-runtime";
const CHAT = "chat-porto";
const OTHER_CHAT = "chat-laptops";
const IDENTITY = JSON.stringify(["user-1", "project-1", CHAT]);
const TASK = "Open https://www.visitporto.travel/ and find the Livraria Lello opening hours.";

function page(id: string, url: string, overrides: Partial<BrowserSessionPage> = {}): BrowserSessionPage {
  const host = url.startsWith("http") ? new URL(url).host : "";
  return { id, url, host, label: host || "New tab", title: null, lastReferencedAt: 1, isActive: false, ...overrides };
}
const scope = (conversationId: string): ChatBrowserTabScope =>
  ({ userId: "user-1", projectId: "project-1", conversationId, runtimeId: HOST });

// The other chat's browser turn left its page in front.
const LAPTOPS = page("PAGE-LAPTOPS", "https://frame.work/at/en/laptop12", { isActive: true });
const LAPTOPS_RUN: RunRecord = {
  id: "run-laptops", projectId: "project-1", sessionId: null, conversationId: OTHER_CHAT, promptId: null, runType: "prompt",
  status: "success", progress: 1, progressStage: null, previewUrl: null, lastMessage: null,
  createdAt: "2026-10-30T21:11:33Z", updatedAt: "2026-10-30T21:13:00Z",
  metadata: { browserTransport: "shared", browserRuntimeId: HOST, browserPageId: LAPTOPS.id, initiatingUserId: "user-1" },
};

type Sent = { tab: BrowserSessionPageTarget | null; extras: { metadata: Record<string, unknown> } };

/**
 * The card, the chat's own tab and the chat's turn target, joined as
 * ChatPanel joins them (chatPanelChatBrowserView.test.ts reads that it
 * does): the card's turn is ready by `chatBrowserCardReady`, and it is sent
 * to the tab `resolveForTurn` gives the chat.
 */
type HarnessProps = {
  messages: ChatMessage[];
  pages: BrowserSessionPage[];
  open: boolean;
  auto: BrowserAutoStartOptions;
  openPage: () => Promise<string | null>;
  activate: (transport: string, plan: BrowserAutoStartPlan | null) => void;
  sent: Sent[];
  onError: (message: string) => void;
};
let chatTabNow: BrowserSessionPage | null = null;
function Harness(props: HarnessProps) {
  const chatTab = useChatBrowserTab({
    scope: scope(CHAT), runs: [LAPTOPS_RUN], pages: props.pages, canOpenPage: true, openPage: props.openPage,
  });
  chatTabNow = chatTab.tab;
  const target = chatBrowserTarget({ tab: chatTab.tab, pages: props.pages, resolved: true, canOpenPage: true });
  useChatBrowserRequest({
    identity: IDENTITY, messages: props.messages, canWrite: true, ready: true, transport: "shared", open: props.open,
    busy: false, personalAvailable: false, personalReady: false,
    sharedReady: chatBrowserCardReady({ runtimeId: HOST, target }),
    sharedRuntimeId: HOST, sharedUnavailable: false,
    activate: props.activate,
    continueTask: async (_transport, _message, extras) => {
      props.sent.push({ tab: await chatTab.resolveForTurn(), extras });
      return true;
    },
    onError: props.onError,
    auto: props.auto,
  });
  return null;
}

describe("a browser card in a chat whose Browser view is never opened", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: HarnessProps;
  let snapshot: SharedBrowserHostSnapshot;
  let reading: SharedBrowserHostReading | null;

  async function render() {
    await act(async () => root.render(<Harness {...props} auto={{ ...props.auto }} />));
  }
  async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  /** The person's prompt from this page, and the card its finished run sent. */
  function cardArrives() {
    const prompt = { id: "prompt-job-1", metadata: { clientMessageId: "client-job-1", client: { sessionId: "session-1", userId: "user-1" } } };
    rememberPromptSentFromThisPage(prompt);
    recordRunsStartedByPromptSentFromThisPage({ metadata: { clientMessageId: "client-job-1" } }, ["run-job-1", "job-1"]);
    props.messages = [
      { id: prompt.id, role: "user", authorId: "user-1", content: TASK, timestamp: Date.now(), metadata: prompt.metadata },
      { id: "card-job-1", role: "assistant", content: "Continue this task in Instafy's browser.", timestamp: Date.now(),
        metadata: { messageType: "action_request", jobId: "job-1", details: { browserRequest: { task: TASK, location: "auto" } } } },
    ];
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-30T21:15:03Z"));
    forgetBrowserAutoStartsForTests();
    forgetPromptsSentFromThisPageForTests();
    forgetChatBrowserTabsForTests();
    chatTabNow = null;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    snapshot = { version: 1, mode: "lazy", state: "ready", generation: "gen-1", failure: null, startedByYou: false,
      othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false };
    reading = null;
    const now = new Date().toISOString();
    // Instafy's browser on the chat's own machine, in a space the controller covers.
    const runtimes = [{ runtimeId: HOST, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime",
      health: "online", isLocal: false, lastSeenAt: now, idleTtlSeconds: 900, isPreferred: true, createdAt: now,
      origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] },
      sharedBrowserHost: { version: 1, mode: "lazy" } }] as ControllerRuntimeStatusEntry[];
    const auto: BrowserAutoStartOptions = {
      currentUserId: "user-1", chatClientSessionId: "session-1", activeRunIds: new Set(), blocked: null, heldByOther: false,
      plan: (_request, transport) => browserAutoStartPlan({
        transport, personalAvailable: false, personalOwnAi: true, projectId: "project-1", runtimes,
        sharedBrowserHostPolicy: "covered", conversationRuntimeId: HOST,
        host: reading?.snapshot ?? null, hostReadAtMs: reading?.receivedAtMs ?? null, nowMs: Date.now(),
      }),
      refreshHost: vi.fn(async () => {
        reading = { snapshot, fetchedAtMs: Date.now(), receivedAtMs: Date.now() };
        props.auto = { ...props.auto, revision: String(reading.fetchedAtMs) };
        await render();
        return reading;
      }),
      // In Chat the roster is not connected: a fresh reading says who is there.
      presence: null,
      revision: "",
    };
    props = {
      messages: [], pages: [LAPTOPS], open: false, auto,
      openPage: vi.fn(async () => "PAGE-PORTO"),
      // Studio's own start opens the browser and leaves the person in Chat.
      activate: vi.fn(() => { props.open = true; }),
      sent: [], onError: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("starts its turn by itself within seconds, in a tab of the chat's own, never the page another chat left in front", async () => {
    await render(); await advance(5_000);
    cardArrives();
    await render();
    for (let waited = 0; waited < 10_000 && props.sent.length === 0; waited += 100) {
      await render(); await advance(100);
    }
    // No press, and the Browser view never came on screen.
    expect(props.activate).toHaveBeenCalledExactlyOnceWith("shared", { kind: "attach", runtimeId: HOST });
    expect(props.sent).toHaveLength(1);
    expect(props.sent[0]!.extras.metadata).toMatchObject({ browserRequestOf: "job:job-1", browserAutoStarted: true });
    // The turn runs in a blank tab opened for this chat.
    expect(props.openPage).toHaveBeenCalledOnce();
    expect(props.sent[0]!.tab).toMatchObject({ id: "PAGE-PORTO", url: "about:blank" });
    expect(props.onError).not.toHaveBeenCalled();
    // Each chat keeps its own tab: this chat's view shows only its new tab,
    // and the other chat's page stays the other chat's.
    props.pages = [LAPTOPS, page("PAGE-PORTO", "about:blank")];
    await render();
    expect(chatTabNow?.id).toBe("PAGE-PORTO");
    expect(chatViewPageIds(chatTabNow?.id ?? null, CHAT_VIEW_TURN_TABS_START)).toEqual(["PAGE-PORTO"]);
    expect(chatBrowserTab({ scope: scope(OTHER_CHAT), runs: [LAPTOPS_RUN], pages: props.pages })?.id).toBe(LAPTOPS.id);
  });

  it("takes the blank tab a browser that just started shows, once it lists it", async () => {
    // The space's browser is not running yet: it lists no tab until it starts.
    props.pages = [];
    await render(); await advance(5_000);
    cardArrives();
    await render();
    await advance(1_000);
    expect(props.sent).toHaveLength(0);
    props.pages = [page("PAGE-FIRST", "about:blank", { isActive: true })];
    for (let waited = 0; waited < 10_000 && props.sent.length === 0; waited += 100) {
      await render(); await advance(100);
    }
    expect(props.sent).toHaveLength(1);
    expect(props.sent[0]!.tab).toMatchObject({ id: "PAGE-FIRST" });
    expect(props.openPage).not.toHaveBeenCalled();
  });
});
