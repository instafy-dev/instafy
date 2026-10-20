// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../../types";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartPlan,
  forgetBrowserAutoStartsForTests,
  markBrowserAutoStartDeclined,
  type BrowserAutoStartPlan,
} from "../browserAutoStart";
import { useChatBrowserRequest, type BrowserAutoStartOptions } from "../useChatBrowserRequest";

type Options = Parameters<typeof useChatBrowserRequest>[0];
type State = ReturnType<typeof useChatBrowserRequest>;
let lastState: State | null = null;
function Harness({ value }: { value: Options }) { lastState = useChatBrowserRequest(value); return null; }
function request(location = "auto", extra: Record<string, unknown> = {}): ChatMessage {
  return { id: "request-1", role: "assistant", content: "Continue in browser", timestamp: 1,
    metadata: { messageType: "action_request", details: { browserRequest: { task: "Continue comparing our earlier choices.", location, ...extra } } } };
}

const IDENTITY = "[\"user-1\",\"project-1\",\"conversation-1\"]";
const TASK = "Open https://app.example.test/settings and take me to API keys. Stop on the list.";

describe("Chat browser request handoff", () => {
  let root: Root;
  let container: HTMLDivElement;
  let value: Options;
  async function render() { await act(async () => root.render(<Harness value={{ ...value }} />)); }
  async function begin(messageId = "request-1") {
    const detail: { messageId: string; completion?: Promise<unknown> } = { messageId };
    let result: Promise<Error | null> | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:request-browser", { detail }));
      result = detail.completion?.then(() => null, (error: Error) => error);
    });
    return { result, detail };
  }
  async function advance(ms = 100) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  beforeEach(() => {
    vi.useFakeTimers();
    forgetBrowserAutoStartsForTests();
    forgetPromptsSentFromThisPageForTests();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    value = { identity: "user/project/conversation", messages: [request()], canWrite: true, ready: true,
      transport: "personal", open: false, busy: false, personalAvailable: true, personalReady: false, sharedReady: false,
      sharedUnavailable: false, activate: vi.fn(), continueTask: vi.fn(async () => true), onError: vi.fn() };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); await advance(); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["personal", "shared"] as const)("uses the selected %s browser and continues the task only once ready", async (transport) => {
    value.transport = transport; await render();
    const attempt = await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith(transport, null);
    await advance(); expect(value.continueTask).not.toHaveBeenCalled();
    value.open = true; value.personalReady = true; value.sharedReady = true; await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith(transport, expect.stringContaining("Continue comparing our earlier choices."), {
      // The chat records it as a notice naming the card, not as the person's words.
      display: "Octo opened Instafy's browser",
      metadata: { browserRequestOf: "message:request-1" },
      // The card names no host, so it gives the browser none.
      knownHosts: [],
    });
    expect(lastState?.cardStates.get("message:request-1")).toEqual({ kind: "opened" });
  });

  it("honors an explicit Workspace request after a native default and waits for the original run to finish", async () => {
    value.messages = [request("workspace")]; value.busy = true; await render();
    const attempt = await begin(); expect(value.activate).toHaveBeenCalledWith("shared", null);
    value.transport = "shared"; value.open = true; value.sharedReady = true; await render(); await advance();
    expect(value.continueTask).not.toHaveBeenCalled();
    value.busy = false; await render(); await advance(); expect(await attempt.result).toBeNull();
  });

  it("continues an action wrapped by the controller's persisted job-message metadata", async () => {
    const message = request();
    value.messages = [{ ...message, metadata: {
      messageType: "action_request",
      jobId: "job-1",
      details: { ...message.metadata, runtimeId: "ordinary-chat-runtime" },
    } }];
    await render();
    const attempt = await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", null);
    value.open = true; value.personalReady = true;
    await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith(
      "personal",
      expect.stringContaining("Continue comparing our earlier choices."),
      expect.objectContaining({ metadata: { browserRequestOf: "job:job-1" } }),
    );
  });

  it("keeps an unavailable native profile from silently becoming a Workspace task", async () => {
    value.messages = [request("device")]; value.transport = "shared"; value.personalAvailable = false; await render();
    const attempt = await begin();
    expect(await attempt.result).toMatchObject({ message: expect.stringContaining("desktop app") });
    expect(value.activate).not.toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
  });

  it("opens Instafy's browser for an automatic card while its availability is not known", async () => {
    // The card's own `workspaceBrowser: false`, which a runtime once sent from
    // its own setting, does not count: the Workspace browser runs elsewhere.
    value.messages = [request("auto", { workspaceBrowser: false })]; value.transport = "shared";
    value.personalAvailable = false; await render();
    const attempt = await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("shared", null);
    value.open = true; value.sharedReady = true; await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("shared", expect.stringContaining("Continue comparing our earlier choices."), expect.anything());
  });

  it("opens an automatic card on this device when the Workspace browser is known not to open", async () => {
    value.messages = [request("auto")]; value.transport = "shared"; value.sharedUnavailable = true; await render();
    await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", null);
  });

  it("sends an automatic card on Desktop to Instafy's browser when the person's turns use Instafy AI", async () => {
    // Dispatch refuses a turn on this device's runtime with Instafy AI.
    value.messages = [request("auto")]; value.transport = "personal"; value.personalTurnsAllowed = false; await render();
    await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("shared", null);
  });

  it("refuses a card that cannot open any browser", async () => {
    value.messages = [request("auto")]; value.transport = "shared"; value.personalAvailable = false;
    value.sharedUnavailable = true; await render();
    const attempt = await begin();
    expect(await attempt.result).toMatchObject({ message: "Instafy's browser is not available in this workspace." });
    expect(value.activate).not.toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
  });

  it.each(["identity", "permission", "closed", "transport"])("cancels when %s changes during startup", async (change) => {
    await render(); const attempt = await begin();
    value.open = true; await render(); await advance();
    if (change === "identity") value.identity = "another conversation";
    if (change === "permission") value.canWrite = false;
    if (change === "closed") value.open = false;
    if (change === "transport") value.transport = "shared";
    await render(); await advance();
    expect(await attempt.result).toBeInstanceOf(Error); expect(value.continueTask).not.toHaveBeenCalled();
  });

  it("does not replay history or trust event arguments from an unrelated message", async () => {
    await render(); await advance(60_100); expect(value.activate).not.toHaveBeenCalled();
    expect((await begin("different-message")).detail.completion).toBeUndefined();
    value.messages = [{ ...request(), role: "user" }]; await render();
    expect((await begin()).detail.completion).toBeUndefined();
  });

  it("restores the button with the error when the continuation is not dispatched", async () => {
    // The dispatch failed: nothing opened, so the card must not read Opened.
    value.continueTask = vi.fn(async () => { throw new Error("The controller did not start a browser turn."); });
    await render();
    const attempt = await begin();
    value.open = true; value.personalReady = true; await render(); await advance();
    expect(await attempt.result).toMatchObject({ message: "The controller did not start a browser turn." });
    expect(lastState?.cardStates.get("message:request-1"))
      .toEqual({ kind: "button", reason: "The controller did not start a browser turn." });
    expect(value.onError).toHaveBeenCalledWith("The controller did not start a browser turn.");
  });

  it("sends the card's task again for Try again, never the notice, naming the card and the failure", async () => {
    const notice: ChatMessage = { id: "notice-1", role: "user", content: "Octo opened Instafy's browser", timestamp: 2,
      metadata: { browserRequestOf: "message:request-1", displayContent: "Octo opened Instafy's browser",
        dispatchContent: "Continue this browser task.", browserTransport: "desktop-personal" } };
    value.messages = [request(), notice]; value.open = true; value.personalReady = true;
    await render();
    let sent: Promise<boolean> | undefined;
    await act(async () => { sent = lastState!.retryContinuation(notice, { retryOfMessageId: "failure-1" }); });
    await advance();
    expect(await sent).toBe(true);
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("personal", expect.stringContaining("Continue comparing our earlier choices."), {
      display: "Octo opened Instafy's browser",
      metadata: { retryOfMessageId: "failure-1", browserRequestOf: "message:request-1" },
      knownHosts: [],
    });
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", null);
  });

  it("reads the task back from the continuation when its card is no longer loaded", async () => {
    const task = "Open https://app.example.test/settings and stop on API keys.";
    const notice: ChatMessage = { id: "notice-1", role: "user", content: "Octo opened Instafy's browser at app.example.test", timestamp: 2,
      metadata: { prompt_metadata: { browserRequestOf: "job:old", browserTransport: "shared",
        dispatchContent: `Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.\n\n${task}` } } };
    value.messages = [notice]; value.transport = "shared"; value.open = true; value.sharedReady = true;
    await render();
    let sent: Promise<boolean> | undefined;
    await act(async () => { sent = lastState!.retryContinuation(notice, { retryOfMessageId: "failure-1" }); });
    await advance();
    expect(await sent).toBe(true);
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("shared", expect.stringMatching(/\n\nOpen https:\/\/app\.example\.test\/settings and stop on API keys\.$/), {
      display: "Octo opened Instafy's browser at app.example.test",
      metadata: { retryOfMessageId: "failure-1", browserRequestOf: "job:old" },
      knownHosts: ["app.example.test"],
    });
  });

  it("bounds a press at two minutes and retains a retry path", async () => {
    await render(); const attempt = await begin(); await advance(60_100);
    // A browser runtime that starts cold can take longer than a minute.
    expect(value.onError).not.toHaveBeenCalled();
    await advance(60_000);
    expect(await attempt.result).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.onError).toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
    value.open = true; value.personalReady = true; await render(); const retry = await begin(); await advance();
    expect(await retry.result).toBeNull(); expect(value.continueTask).toHaveBeenCalledTimes(1);
  });
});

/**
 * Octo opens Instafy's browser by itself (owner decision, Oct 19): Studio
 * starts a card in the tab whose prompt asked for it, once that run is done.
 * Only the browser in the desktop app, for a person on their own AI, starts
 * this way; Instafy's hosted browser always waits for a press.
 */
describe("Studio starting a request_browser card by itself", () => {
  let root: Root;
  let container: HTMLDivElement;
  let value: Options;
  let auto: BrowserAutoStartOptions;
  let visibility: DocumentVisibilityState;
  const plan = vi.fn<(...args: unknown[]) => BrowserAutoStartPlan>();
  const PERSONAL = { kind: "personal" } as const;

  async function render() {
    await act(async () => root.render(<Harness value={{ ...value, auto: value.auto ? {
      ...auto,
      revision: JSON.stringify([auto.blocked, auto.heldByOther]),
    } : null }} />));
  }
  async function advance(ms = 100) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  /** The prompt this page sent, and the run the controller started for it. */
  function sendPrompt(metadata: Record<string, unknown> = {}, jobId = "job-1", content = "What does the settings page on app.example.test say?") {
    const prompt = { id: `prompt-${jobId}`, metadata: {
      clientMessageId: `client-${jobId}`, client: { sessionId: "session-1", userId: "user-1" }, ...metadata,
    } };
    rememberPromptSentFromThisPage(prompt);
    recordRunsStartedByPromptSentFromThisPage({ metadata: { clientMessageId: `client-${jobId}` } }, [`run-${jobId}`, jobId]);
    return { id: prompt.id, role: "user" as const, authorId: "user-1", content, timestamp: Date.now(), metadata: prompt.metadata };
  }
  function card(jobId = "job-1", timestamp = Date.now()): ChatMessage {
    return { id: `card-${jobId}`, role: "assistant", content: "Continue this task in Instafy's browser.", timestamp,
      metadata: { messageType: "action_request", jobId, details: { browserRequest: { task: TASK, location: "auto" } } } };
  }
  /** Opens the conversation, then the asking turn ends with a card. */
  async function cardArrives(options: { prompt?: Record<string, unknown>; jobId?: string; content?: string } = {}) {
    await render();
    await advance(5_000);
    const prompt = sendPrompt(options.prompt, options.jobId, options.content);
    value.messages = [...value.messages, prompt, card(options.jobId)];
    await render();
    await advance(10);
  }
  async function becomeReady() {
    value.open = true; value.sharedReady = true; value.personalReady = true;
    await render(); await advance();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-19T12:00:00Z"));
    forgetBrowserAutoStartsForTests();
    forgetPromptsSentFromThisPageForTests();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    plan.mockReset();
    plan.mockReturnValue(PERSONAL);
    auto = { currentUserId: "user-1", chatClientSessionId: "session-1", activeRunIds: new Set(), blocked: null,
      heldByOther: false, plan, revision: "" };
    value = { identity: IDENTITY, messages: [], canWrite: true, ready: true, transport: "personal", open: false, busy: false,
      personalAvailable: true, personalReady: false, sharedReady: false, sharedUnavailable: false,
      activate: vi.fn(), continueTask: vi.fn(async () => true), onError: vi.fn(), auto };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); await advance(); container.remove();
    vi.restoreAllMocks(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("starts a fresh card from a run this page started, once that run has finished", async () => {
    auto.activeRunIds = new Set(["run-job-1", "job-1"]);
    await cardArrives();
    expect(value.activate).not.toHaveBeenCalled();
    auto.activeRunIds = new Set();
    await render();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", PERSONAL);
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "opening", note: null });
    await becomeReady();
    // It is marked as Studio's own start, so the browser chooses its approval
    // mode by the Desktop's policy, and carries the hosts the card shows.
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("personal", expect.stringContaining(TASK), {
      display: "Octo opened Instafy's browser at app.example.test",
      metadata: { browserRequestOf: "job:job-1", browserAutoStarted: true },
      knownHosts: ["app.example.test"],
    });
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "opened" });
  });

  it("waits while the conversation is still busy", async () => {
    value.busy = true;
    await cardArrives();
    expect(value.activate).not.toHaveBeenCalled();
    value.busy = false; await render();
    expect(value.activate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["history from before the conversation was opened", async () => {
      await render(); await advance(5_000);
      value.messages = [sendPrompt(), card("job-1", Date.now() - 60_000)];
      await render();
    }],
    ["another viewer's or another tab's prompt", async () => {
      await render(); await advance(5_000);
      value.messages = [card()];
      await render();
    }],
    ["a reload, which forgets what this page sent", async () => {
      await render(); await advance(5_000);
      const prompt = sendPrompt();
      forgetPromptsSentFromThisPageForTests();
      value.messages = [prompt, card()];
      await render();
    }],
    ["the same person in another tab", async () => {
      auto.chatClientSessionId = "session-2";
      await cardArrives();
    }],
    ["a card a Shared Browser turn sent", async () => { await cardArrives({ prompt: { browserTransport: "shared" } }); }],
    ["a card a continuation's turn sent", async () => { await cardArrives({ prompt: { browserRequestOf: "job:job-0" } }); }],
    ["a viewer who cannot write", async () => { value.canWrite = false; await cardArrives(); }],
    ["a browser that cannot open here", async () => {
      value.personalAvailable = false; value.sharedUnavailable = true; await cardArrives();
    }],
    ["a card someone answered", async () => {
      await cardArrives();
    }],
  ] as const)("does not start for %s", async (name, arrange) => {
    if (name === "a card someone answered") {
      // A person writes after the card before its run settles.
      auto.activeRunIds = new Set(["job-1"]);
      await arrange();
      value.messages = [...value.messages, { id: "reply", role: "user", content: "Never mind", timestamp: Date.now() }];
      auto.activeRunIds = new Set();
      await render();
    } else {
      await arrange();
    }
    await advance(1_000);
    expect(value.activate).not.toHaveBeenCalled();
    expect(value.continueTask).not.toHaveBeenCalled();
  });

  it("does not start a card older than ten minutes, for example one a background tab kept", async () => {
    visibility = "hidden";
    await cardArrives();
    await advance(10 * 60_000 + 1_000);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance();
    expect(value.activate).not.toHaveBeenCalled();
  });

  it("waits for a hidden tab to be seen", async () => {
    visibility = "hidden";
    await cardArrives();
    expect(value.activate).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", PERSONAL);
  });

  it.each([
    ["a draft in the composer", () => { auto.blocked = { reason: null }; }, null],
    ["a browser someone else is using", () => { auto.heldByOther = true; }, BROWSER_AUTO_START_COPY.inUse],
    ["a conversation where the person closed the browser", () => { markBrowserAutoStartDeclined(IDENTITY); }, null],
    ["a person on Instafy AI", () => { plan.mockReturnValue({ kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi }); }, BROWSER_AUTO_START_COPY.personalNeedsOwnAi],
  ] as const)("leaves the button for %s, with the reason", async (_name, arrange, reason) => {
    arrange();
    await cardArrives();
    expect(value.activate).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason });
  });

  it("looks at a held card again once what held it clears", async () => {
    // A draft or a browser in use only holds the card for now.
    auto.blocked = { reason: null };
    await cardArrives();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: null });
    auto.blocked = null; auto.heldByOther = true;
    await render();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.inUse });
    auto.heldByOther = false;
    await render();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", PERSONAL);
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "opening", note: null });
  });

  it("leaves the card for an address Octo found itself, and opens one the person wrote", async () => {
    await cardArrives({ content: "Find the settings page for me." });
    expect(value.activate).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.unseenAddress });
  });

  it("never opens Instafy's hosted browser by itself, even in a session already running here", async () => {
    // The controller does not record who started a session: it may be a
    // teammate's, with their pages and sign-ins.
    const now = new Date().toISOString();
    const runtimes = [{ runtimeId: "session-1", status: "ready", provider: "instafy-cloud", displayName: "Browser session",
      health: "online", isLocal: false, lastSeenAt: now, idleTtlSeconds: 900, isPreferred: false, createdAt: now,
      origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } }] as ControllerRuntimeStatusEntry[];
    value.transport = "shared"; value.personalAvailable = false;
    plan.mockImplementation((_request, transport) => browserAutoStartPlan({
      transport: transport as "shared", personalAvailable: false, personalOwnAi: true, projectId: "project-1", runtimes,
    }));
    await cardArrives();
    await becomeReady();
    expect(value.activate).not.toHaveBeenCalled();
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
  });

  it("claims each card once across remounts and starts one card per conversation in ten minutes", async () => {
    await cardArrives();
    expect(value.activate).toHaveBeenCalledTimes(1);
    await becomeReady();
    await act(async () => root.unmount());
    root = createRoot(container);
    value.open = false; value.sharedReady = false;
    await render(); await advance();
    expect(value.activate).toHaveBeenCalledTimes(1);
    // A second card a minute later stays a button.
    const prompt = sendPrompt({}, "job-2");
    value.messages = [...value.messages, prompt, card("job-2")];
    await render(); await advance();
    expect(value.activate).toHaveBeenCalledTimes(1);
    expect(lastState?.cardStates.get("job:job-2")).toEqual({ kind: "button", reason: null });
  });

  it("gives the browser two minutes, and leaves the button when it does not open", async () => {
    await cardArrives();
    await advance(119_000);
    expect(value.onError).not.toHaveBeenCalled();
    await advance(1_200);
    expect(value.onError).toHaveBeenCalledWith(BROWSER_AUTO_START_COPY.timedOut);
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.timedOut });
    expect(value.continueTask).not.toHaveBeenCalled();
  });

  it("never takes the browser from someone who started using it meanwhile", async () => {
    await cardArrives();
    auto.heldByOther = true;
    await becomeReady();
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.inUse });
  });

  it.each([
    ["someone wrote after the card", () => {
      value.messages = [...value.messages, { id: "reply", role: "user", content: "Actually, skip it", timestamp: Date.now() }];
    }],
    ["another run started in the conversation", () => { auto.activeRunIds = new Set(["run-other"]); }],
    ["the person started a draft", () => { auto.blocked = { reason: null }; }],
  ] as const)("drops the start without a word when %s while the browser opened", async (_name, change) => {
    await cardArrives();
    expect(value.activate).toHaveBeenCalledTimes(1);
    change();
    await becomeReady();
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(value.onError).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: null });
  });

  it("starts the browser on this device for a person on their own AI", async () => {
    await cardArrives();
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ task: TASK }), "personal");
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", PERSONAL);
  });
});
