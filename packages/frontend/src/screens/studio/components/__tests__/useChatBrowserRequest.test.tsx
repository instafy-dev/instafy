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
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartPlan,
  forgetBrowserAutoStartsForTests,
  isBrowserAutoStartClaimed,
  markBrowserAutoStartDeclined,
  type BrowserAutoStartPlan,
  type SharedBrowserPresence,
} from "../browserAutoStart";
import { SHARED_BROWSER_HOST_COPY } from "../sharedBrowserHostAttach";
import type { SharedBrowserHostReading, SharedBrowserHostRefresh } from "../useSharedBrowserHostSnapshot";
import {
  BROWSER_REQUEST_COPY,
  useChatBrowserRequest,
  type BrowserAutoStartOptions,
} from "../useChatBrowserRequest";

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
      // The chat records it as a notice naming the card, not as the person's
      // words, and never says Octo did what the person pressed.
      display: "Opened Instafy's browser",
      metadata: { browserRequestOf: "message:request-1" },
      // The card names no host, so it gives the browser none.
      knownHosts: [],
    });
    expect(lastState?.cardStates.get("message:request-1")).toEqual({ kind: "opened" });
  });

  // Local drive, Oct 28: a question's browser turn was followed by a turn
  // nobody asked for. Only a card Octo builds from asks for a hand-back.
  it("marks the continuation of a card Octo builds from, and only that one", async () => {
    value.messages = [request("auto", { continueBuilding: true })]; await render();
    let attempt = await begin();
    value.open = true; value.personalReady = true; await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenLastCalledWith("personal", expect.any(String),
      expect.objectContaining({ metadata: { browserRequestOf: "message:request-1", browserHandsBack: true } }));

    value.messages = [{ ...request(), id: "request-2" }]; await render();
    attempt = await begin("request-2"); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenLastCalledWith("personal", expect.any(String),
      expect.objectContaining({ metadata: { browserRequestOf: "message:request-2" } }));
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
    // The dispatch failed: nothing opened, so the card must not read Browser opened.
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
      display: "Opened Instafy's browser",
      metadata: { retryOfMessageId: "failure-1", browserRequestOf: "message:request-1" },
      knownHosts: [],
    });
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", null);
  });

  it("reads the task back from the continuation when its card is no longer loaded", async () => {
    const task = "Open https://app.example.test/settings and stop on API keys.";
    const notice: ChatMessage = { id: "notice-1", role: "user", content: "Octo opened Instafy's browser for app.example.test", timestamp: 2,
      metadata: { prompt_metadata: { browserRequestOf: "job:old", browserTransport: "shared",
        dispatchContent: `Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.\n\n${task}` } } };
    value.messages = [notice]; value.transport = "shared"; value.open = true; value.sharedReady = true;
    await render();
    let sent: Promise<boolean> | undefined;
    await act(async () => { sent = lastState!.retryContinuation(notice, { retryOfMessageId: "failure-1" }); });
    await advance();
    expect(await sent).toBe(true);
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("shared", expect.stringMatching(/\n\nOpen https:\/\/app\.example\.test\/settings and stop on API keys\.$/), {
      display: "Opened Instafy's browser for app.example.test",
      metadata: { retryOfMessageId: "failure-1", browserRequestOf: "job:old" },
      knownHosts: ["app.example.test"],
    });
  });

  it("bounds a press for Instafy's browser at four minutes and retains a retry path", async () => {
    value.transport = "shared"; value.personalAvailable = false;
    await render(); const attempt = await begin(); await advance(60_100);
    // A browser runtime that starts cold can take longer than a minute.
    expect(value.onError).not.toHaveBeenCalled();
    // A press may also start the space's machine first (up to three minutes)
    // and then its browser, so two minutes is not the end of it.
    await advance(120_000);
    expect(value.onError).not.toHaveBeenCalled();
    await advance(60_000);
    expect(await attempt.result).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.activate).toHaveBeenCalledWith("shared", null);
    expect(value.onError).toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
    value.open = true; value.sharedReady = true; await render(); const retry = await begin(); await advance();
    expect(await retry.result).toBeNull(); expect(value.continueTask).toHaveBeenCalledTimes(1);
  });

  it("bounds a press for the browser on this device at two minutes and retains a retry path", async () => {
    await render(); const attempt = await begin(); await advance(60_100);
    expect(value.onError).not.toHaveBeenCalled();
    await advance(60_000);
    expect(await attempt.result).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.activate).toHaveBeenCalledWith("personal", null);
    expect(value.onError).toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
    value.open = true; value.personalReady = true; await render(); const retry = await begin(); await advance();
    expect(await retry.result).toBeNull(); expect(value.continueTask).toHaveBeenCalledTimes(1);
  });
});

/**
 * A press for Instafy's browser on the conversation's own machine never waits
 * silently (dogfood, Oct 22: the card read "Opening browser…" for minutes):
 * it reads that browser, says at once why it cannot open, and asks a browser
 * that was open already, or whose machine's browser went idle, to attach
 * again, never while someone else holds it.
 */
describe("Pressing a card for Instafy's browser on the conversation's machine", () => {
  let root: Root;
  let container: HTMLDivElement;
  let value: Options;
  let reading: SharedBrowserHostSnapshot;
  const HOST = "host-runtime";
  const refresh = vi.fn<SharedBrowserHostRefresh>();
  const reattach = vi.fn();
  async function render() { await act(async () => root.render(<Harness value={{ ...value }} />)); }
  async function begin() {
    const detail: { messageId: string; completion?: Promise<unknown> } = { messageId: "request-1" };
    let result: Promise<Error | null> | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:request-browser", { detail }));
      result = detail.completion?.then(() => null, (error: Error) => error);
    });
    let settled: Error | null | undefined;
    void result?.then((outcome) => { settled = outcome; });
    return { result: result!, settled: () => settled };
  }
  async function advance(ms = 100) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  function host(overrides: Partial<SharedBrowserHostSnapshot> = {}): SharedBrowserHostSnapshot {
    return { version: 1, mode: "lazy", state: "ready", generation: "gen-1", failure: null, startedByYou: false,
      othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false, ...overrides };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    forgetBrowserAutoStartsForTests();
    forgetPromptsSentFromThisPageForTests();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    reading = host();
    refresh.mockReset().mockImplementation(async () => ({ snapshot: reading, fetchedAtMs: Date.now(), receivedAtMs: Date.now() }));
    reattach.mockReset();
    // The browser is open on the conversation's machine but shows no page.
    value = { identity: "user/project/conversation", messages: [request()], canWrite: true, ready: true,
      transport: "shared", open: true, busy: false, personalAvailable: false, personalReady: false, sharedReady: false,
      sharedRuntimeId: HOST, sharedUnavailable: false, activate: vi.fn(), continueTask: vi.fn(async () => true), onError: vi.fn(),
      sharedHost: { runtimeId: HOST, refresh, reattach, heldByOther: false } };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); await advance(); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("says at once that a poisoned browser needs the machine to restart", async () => {
    reading = host({ state: "poisoned" });
    await render();
    const attempt = await begin();
    await advance(1_000);
    expect(attempt.settled()).toMatchObject({ message: SHARED_BROWSER_HOST_COPY.poisoned });
    expect(refresh).toHaveBeenCalledWith({ force: true });
    expect(value.onError).toHaveBeenCalledWith(SHARED_BROWSER_HOST_COPY.poisoned);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("message:request-1")).toEqual({ kind: "button", reason: SHARED_BROWSER_HOST_COPY.poisoned });
  });

  it("asks an open browser whose machine's browser went idle to attach again, once, and sends once it is ready", async () => {
    reading = host({ state: "idle" });
    await render();
    const attempt = await begin();
    await advance();
    expect(reattach).toHaveBeenCalledTimes(1);
    // It keeps reading while the view starts it, and never asks again.
    await advance(10_000);
    expect(refresh.mock.calls.length).toBeGreaterThan(2);
    expect(reattach).toHaveBeenCalledTimes(1);
    reading = host({ state: "ready", startedByYou: true });
    value.sharedReady = true;
    await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledTimes(1);
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("attaches an open browser that is not on the conversation's machine again, without reading it", async () => {
    value.sharedRuntimeId = "browser-session-runtime";
    await render();
    await begin();
    await advance(5_000);
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["another run or person holds the browser", () => { value.sharedHost = { ...value.sharedHost!, heldByOther: true }; }],
    ["another person's run works in it", () => { reading = host({ state: "idle", agentRunActive: true }); }],
  ] as const)("never attaches again while %s", async (_name, arrange) => {
    reading = host({ state: "idle" });
    arrange();
    await render();
    await begin();
    await advance(15_000);
    expect(reattach).not.toHaveBeenCalled();
  });

  it("gives a browser it opened three seconds before reading it, and ten before attaching again", async () => {
    value.open = false; value.sharedRuntimeId = null;
    reading = host({ state: "idle" });
    await render();
    await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("shared", null);
    value.open = true; value.sharedRuntimeId = HOST;
    await render();
    await advance(2_500);
    expect(refresh).not.toHaveBeenCalled();
    await advance(1_000);
    expect(refresh).toHaveBeenCalledWith({ force: true });
    expect(reattach).not.toHaveBeenCalled();
    // Readings every three seconds; the one after ten seconds asks again.
    await advance(6_000);
    expect(reattach).not.toHaveBeenCalled();
    await advance(3_000);
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("says the browser did not start when it failed again after attaching again", async () => {
    reading = host({ state: "failed", failure: "chromium_exited" });
    await render();
    const attempt = await begin();
    await advance();
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(attempt.settled()).toBeUndefined();
    // The view started it again, and that new run failed too.
    reading = host({ state: "failed", generation: "gen-2", failure: "chromium_exited" });
    await advance(3_100);
    expect(attempt.settled()).toMatchObject({ message: SHARED_BROWSER_HOST_COPY.didNotOpen });
  });

  it("waits for the view to start the browser again instead of taking the run that failed before as its answer", async () => {
    // A slow controller: the view's new start lands well after the next reading.
    reading = host({ state: "failed", failure: "chromium_exited" });
    await render();
    const attempt = await begin();
    await advance();
    expect(reattach).toHaveBeenCalledTimes(1);
    await advance(9_000);
    expect(refresh.mock.calls.length).toBeGreaterThan(2);
    expect(attempt.settled()).toBeUndefined();
    reading = host({ state: "ready", generation: "gen-2", startedByYou: true });
    value.sharedReady = true;
    await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["on the conversation's machine", () => { reading = host({ state: "ready", startedByYou: true }); }],
    ["on another machine", () => { value.sharedRuntimeId = "browser-session-runtime"; }],
  ] as const)("never attaches again an open browser that shows its page %s while the conversation is busy", async (_name, arrange) => {
    value.sharedReady = true; value.busy = true;
    arrange();
    await render();
    const attempt = await begin();
    await advance(5_000);
    expect(reattach).not.toHaveBeenCalled();
    value.busy = false;
    await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledTimes(1);
    expect(reattach).not.toHaveBeenCalled();
  });

  it.each([
    ["its own plain words", SHARED_BROWSER_HOST_COPY.off, SHARED_BROWSER_HOST_COPY.off],
    ["plain words in place of a technical one", "Browser session is unavailable (origin token request failed).", BROWSER_REQUEST_COPY.browserFailed],
  ] as const)("fails as soon as the browser view shows an error, with %s", async (_name, viewMessage, cardMessage) => {
    value.open = false; value.sharedRuntimeId = null;
    await render();
    const attempt = await begin();
    value.open = true; await render(); await advance();
    expect(attempt.settled()).toBeUndefined();
    value.sharedError = { message: viewMessage, atMs: Date.now() };
    await render(); await advance();
    expect(attempt.settled()).toMatchObject({ message: cardMessage });
    expect(value.continueTask).not.toHaveBeenCalled();
  });

  it("does not take an error the view showed before the press as its answer", async () => {
    value.sharedError = { message: SHARED_BROWSER_HOST_COPY.didNotOpen, atMs: Date.now() - 1_000 };
    await render();
    const attempt = await begin();
    await advance(10_000);
    expect(attempt.settled()).toBeUndefined();
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("ends the wait after two minutes of the browser answering that it is not running, not four", async () => {
    value.sharedHost = { runtimeId: HOST, reattach, heldByOther: false };
    // It answered so already before the press; the two minutes count from the press.
    value.sharedNotReadySinceMs = Date.now() - 60_000;
    await render();
    const attempt = await begin();
    await advance(119_000);
    expect(attempt.settled()).toBeUndefined();
    await advance(1_200);
    expect(attempt.settled()).toMatchObject({ message: SHARED_BROWSER_HOST_COPY.didNotOpen });
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
      revision: JSON.stringify([auto.blocked, auto.heldByOther, auto.revision]),
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

  const HOST_ID = "host-runtime";
  const KNOWN_ALONE: SharedBrowserPresence = { status: "known", othersPresent: false, remoteController: false };
  function snapshot(overrides: Partial<SharedBrowserHostSnapshot> = {}): SharedBrowserHostSnapshot {
    return { version: 1, mode: "lazy", state: "ready", generation: "gen-1", failure: null, startedByYou: false,
      othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false, ...overrides };
  }
  /**
   * Instafy's browser on the conversation's own machine in a covered space,
   * planned by the real browserAutoStartPlan. Each reading changes the
   * revision, as ChatPanel's does.
   */
  function coveredHost(overrides: Partial<SharedBrowserHostSnapshot> = {}) {
    const now = new Date().toISOString();
    const runtimes = [{ runtimeId: HOST_ID, status: "ready", provider: "instafy-cloud", displayName: "hosted runtime",
      health: "online", isLocal: false, lastSeenAt: now, idleTtlSeconds: 900, isPreferred: true, createdAt: now,
      origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] },
      sharedBrowserHost: { version: 1, mode: "lazy" } }] as ControllerRuntimeStatusEntry[];
    const host = {
      snapshot: snapshot(overrides),
      last: null as SharedBrowserHostReading | null,
      refreshHost: vi.fn<(options?: { force?: boolean }) => Promise<SharedBrowserHostReading | null>>(async (): Promise<SharedBrowserHostReading | null> => {
        host.last = { snapshot: host.snapshot, fetchedAtMs: Date.now(), receivedAtMs: Date.now() };
        auto.revision = String(host.last.fetchedAtMs);
        return host.last;
      }),
    };
    value.transport = "shared"; value.personalAvailable = false;
    auto.refreshHost = host.refreshHost;
    auto.presence = KNOWN_ALONE;
    plan.mockImplementation((_request, transport) => browserAutoStartPlan({
      transport: transport as "shared", personalAvailable: value.personalAvailable, personalOwnAi: true,
      projectId: "project-1", runtimes, sharedBrowserHostPolicy: "covered", conversationRuntimeId: HOST_ID,
      host: host.last?.snapshot ?? null, hostReadAtMs: host.last?.receivedAtMs ?? null, nowMs: Date.now(),
    }));
    return host;
  }
  /** The reading a pending plan asked for has landed: decide the card again. */
  async function settleReading() {
    await advance(10); await render();
  }
  /** The browser opens on the host and shows its first page. */
  async function openHost(presence: SharedBrowserPresence = KNOWN_ALONE) {
    auto.presence = presence;
    value.transport = "shared"; value.open = true; value.sharedReady = true; value.sharedRuntimeId = HOST_ID;
    await render(); await advance(); await advance();
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
      display: "Octo opened Instafy's browser for app.example.test",
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
    ["a card a hand-back turn sent (one automatic hop only)", async () => {
      // The address was seen in an earlier reply, so only the hop stops it.
      value.messages = [{ id: "earlier", role: "assistant", timestamp: Date.now(),
        content: "Your keys are listed at https://app.example.test/settings." }];
      await cardArrives({ prompt: { continuesFromBrowserJob: "job-0" } });
    }],
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
    ["a host someone else has open", () => { coveredHost({ othersPresent: true }); }, BROWSER_AUTO_START_COPY.hostInUse],
    ["a host someone else controls", () => { coveredHost({ controlledByOther: true }); }, BROWSER_AUTO_START_COPY.hostInUse],
    ["a host another person's run works in", () => { coveredHost({ agentRunActive: true }); }, BROWSER_AUTO_START_COPY.hostInUse],
    ["a host someone else is starting", () => { coveredHost({ state: "starting" }); }, BROWSER_AUTO_START_COPY.hostInUse],
    ["a failed host", () => { coveredHost({ state: "failed" }); }, BROWSER_AUTO_START_COPY.hostFailed],
    ["a poisoned host", () => { coveredHost({ state: "poisoned" }); }, BROWSER_AUTO_START_COPY.hostPoisoned],
  ] as const)("leaves the button for %s, with the reason", async (_name, arrange, reason) => {
    arrange();
    await cardArrives();
    await settleReading();
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

  it("leaves a legacy browser session a button in a covered space", async () => {
    // The controller does not record who started a separate session: it may
    // be a teammate's, with their pages and sign-ins.
    const now = new Date().toISOString();
    const runtimes = [{ runtimeId: "session-1", status: "ready", provider: "instafy-cloud", displayName: "Browser session",
      health: "online", isLocal: false, lastSeenAt: now, idleTtlSeconds: 900, isPreferred: false, createdAt: now,
      origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } }] as ControllerRuntimeStatusEntry[];
    value.transport = "shared"; value.personalAvailable = false;
    plan.mockImplementation((_request, transport) => browserAutoStartPlan({
      transport: transport as "shared", personalAvailable: false, personalOwnAi: true, projectId: "project-1", runtimes,
      sharedBrowserHostPolicy: "covered", conversationRuntimeId: "session-1",
    }));
    await cardArrives();
    await becomeReady();
    expect(value.activate).not.toHaveBeenCalled();
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
  });

  it.each(["idle", "ready"] as const)("attaches to the host on the conversation's machine when it is %s, and sends once it is ready", async (state) => {
    const host = coveredHost({ state });
    await cardArrives();
    // The first decision has no reading yet: it reads the browser and waits.
    expect(value.activate).not.toHaveBeenCalled();
    expect(host.refreshHost).toHaveBeenCalledWith();
    await settleReading();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("shared", { kind: "attach", runtimeId: HOST_ID });
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "opening", note: null });
    host.snapshot = snapshot({ state: "ready", startedByYou: state === "idle" });
    await openHost();
    expect(host.refreshHost).toHaveBeenCalledWith({ force: true });
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("shared", expect.stringContaining(TASK), {
      display: "Octo opened Instafy's browser for app.example.test",
      metadata: { browserRequestOf: "job:job-1", browserAutoStarted: true },
      knownHosts: ["app.example.test"],
    });
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "opened" });
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
    ["someone else opened the host meanwhile", { othersPresent: true }, null],
    ["someone else took control of the host", { controlledByOther: true }, null],
    ["the roster shows another controller", {}, { status: "known", othersPresent: true, remoteController: true }],
  ] as const)("refuses an attach only on a known conflict: %s", async (_name, conflict, presence) => {
    const host = coveredHost();
    await cardArrives(); await settleReading();
    expect(value.activate).toHaveBeenCalledTimes(1);
    host.snapshot = snapshot(conflict);
    await openHost(presence ?? undefined);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(value.onError).toHaveBeenCalledWith(BROWSER_AUTO_START_COPY.inUse);
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.inUse });
  });

  it("drops an attach when the browser moves to another machine before the task is sent", async () => {
    coveredHost();
    auto.presence = { status: "unknown", othersPresent: false, remoteController: false };
    await cardArrives(); await settleReading();
    value.transport = "shared"; value.open = true; value.sharedReady = true; value.sharedRuntimeId = HOST_ID;
    await render(); await advance();
    expect(value.continueTask).not.toHaveBeenCalled();
    value.sharedRuntimeId = "other-runtime";
    await render(); await advance();
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(value.onError).toHaveBeenCalledWith("The browser or conversation changed before this task could continue.");
  });

  it("waits for the browser to show the attached machine instead of sending to another one", async () => {
    const host = coveredHost();
    await cardArrives(); await settleReading();
    // Still on another machine: it waits, and never sends there.
    value.transport = "shared"; value.open = true; value.sharedReady = true; value.sharedRuntimeId = "other-runtime";
    auto.presence = KNOWN_ALONE;
    await render(); await advance(1_000);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(value.onError).not.toHaveBeenCalled();
    expect(host.refreshHost).not.toHaveBeenCalledWith({ force: true });
    value.sharedRuntimeId = HOST_ID;
    await render(); await advance();
    expect(value.continueTask).toHaveBeenCalledTimes(1);
  });

  it("sends the task when the roster connects 300 ms after the first page", async () => {
    const host = coveredHost();
    await cardArrives(); await settleReading();
    auto.presence = { status: "unknown", othersPresent: false, remoteController: false };
    value.transport = "shared"; value.open = true; value.sharedReady = true; value.sharedRuntimeId = HOST_ID;
    await render(); await advance(100);
    expect(value.continueTask).not.toHaveBeenCalled();
    await advance(200);
    auto.presence = KNOWN_ALONE;
    await render(); await advance(200);
    expect(host.refreshHost).toHaveBeenCalledWith({ force: true });
    expect(value.continueTask).toHaveBeenCalledTimes(1);
    expect(value.onError).not.toHaveBeenCalled();
  });

  it("reads the host again, forced, when the last reading is from before the browser opened or not ready yet", async () => {
    const host = coveredHost({ state: "idle" });
    await cardArrives(); await settleReading();
    // The forced readings after the open still show it starting.
    host.snapshot = snapshot({ state: "starting", startedByYou: true });
    await openHost();
    expect(value.continueTask).not.toHaveBeenCalled();
    const forcedBefore = host.refreshHost.mock.calls.filter(([options]) => options?.force).length;
    expect(forcedBefore).toBeGreaterThan(0);
    host.snapshot = snapshot({ state: "ready", startedByYou: true });
    await advance(1_100);
    expect(host.refreshHost.mock.calls.filter(([options]) => options?.force).length).toBeGreaterThan(forcedBefore);
    expect(value.continueTask).toHaveBeenCalledTimes(1);
  });

  it("never sends on a reading from before the browser opened", async () => {
    const host = coveredHost();
    await cardArrives(); await settleReading();
    // The refresh keeps answering with the reading taken before the open.
    const stale = host.last!;
    host.refreshHost.mockImplementation(async () => stale);
    await openHost();
    await advance(5_000);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(host.refreshHost).toHaveBeenCalledWith({ force: true });
  });

  it("times out, not as in use, when the roster never connects", async () => {
    coveredHost();
    await cardArrives(); await settleReading();
    auto.presence = { status: "unknown", othersPresent: false, remoteController: false };
    value.transport = "shared"; value.open = true; value.sharedReady = true; value.sharedRuntimeId = HOST_ID;
    await render();
    await advance(119_000);
    expect(value.onError).not.toHaveBeenCalled();
    await advance(1_200);
    expect(value.onError).toHaveBeenCalledWith(BROWSER_AUTO_START_COPY.timedOut);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.timedOut });
  });

  it("says the roster could not connect when it stays unavailable until the deadline", async () => {
    coveredHost();
    await cardArrives(); await settleReading();
    await openHost({ status: "unavailable", othersPresent: false, remoteController: false });
    await advance(121_000);
    expect(value.onError).toHaveBeenCalledWith(BROWSER_AUTO_START_COPY.presenceUnavailable);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1"))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.presenceUnavailable });
  });

  it("ends the wait at the deadline when a forced reading never answers", async () => {
    const host = coveredHost();
    await cardArrives(); await settleReading();
    host.refreshHost.mockImplementation(() => new Promise(() => {}));
    await openHost();
    expect(host.refreshHost).toHaveBeenCalledWith({ force: true });
    await advance(119_000);
    expect(value.onError).not.toHaveBeenCalled();
    await advance(1_200);
    expect(value.onError).toHaveBeenCalledWith(BROWSER_AUTO_START_COPY.timedOut);
    expect(value.continueTask).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.timedOut });
  });

  it("stops waiting on the host once the card is too old to open, while every reading fails", async () => {
    const host = coveredHost();
    // Each failed reading changes the revision, as ChatPanel's failedAtMs does.
    host.refreshHost.mockImplementation(async () => {
      auto.revision = `failed:${Date.now()}`;
      return null;
    });
    await cardArrives();
    await settleReading();
    expect(lastState?.autoWaiting).toBe(true);
    for (let elapsed = 0; elapsed <= 10 * 60_000; elapsed += 10_000) {
      await advance(10_000);
      await act(async () => { await host.refreshHost(); });
      await render();
    }
    expect(lastState?.autoWaiting).toBe(false);
    expect(value.activate).not.toHaveBeenCalled();
  });

  it("never claims a card while it waits for a reading of the host", async () => {
    const host = coveredHost();
    host.refreshHost.mockImplementation(async () => null);
    await cardArrives();
    await advance(5_000);
    expect(host.refreshHost).toHaveBeenCalled();
    expect(value.activate).not.toHaveBeenCalled();
    expect(isBrowserAutoStartClaimed("job:job-1")).toBe(false);
    expect(lastState?.autoWaiting).toBe(true);
  });

  it("decides a held card again after the next reading", async () => {
    const host = coveredHost({ othersPresent: true });
    await cardArrives(); await settleReading();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.hostInUse });
    expect(lastState?.autoWaiting).toBe(true);
    expect(isBrowserAutoStartClaimed("job:job-1")).toBe(false);
    host.snapshot = snapshot();
    await advance(3_000);
    await act(async () => { await host.refreshHost(); });
    await render();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("shared", { kind: "attach", runtimeId: HOST_ID });
    expect(lastState?.autoWaiting).toBe(false);
  });

  it("does not hold a card for the browser on this device while a teammate views the host", async () => {
    // Who is in Instafy's browser says nothing about the browser on this
    // device: the plan holds only Instafy's browser for it.
    coveredHost({ othersPresent: true, controlledByOther: true });
    value.transport = "personal"; value.personalAvailable = true;
    auto.presence = { status: "known", othersPresent: true, remoteController: false };
    await cardArrives(); await settleReading();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal", PERSONAL);
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

  it("says why a draft holds the card, and opens it once the draft is empty", async () => {
    // Only a draft holds a card; the layout never does (see browserAutoStartHeldByDraft).
    const host = coveredHost();
    auto.blocked = { reason: BROWSER_AUTO_START_COPY.draftHeld };
    await cardArrives();
    // It reads the host first, to know whether the card would open by itself.
    expect(host.refreshHost).toHaveBeenCalledWith();
    await settleReading();
    expect(value.activate).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.draftHeld });
    auto.blocked = null;
    await render();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("shared", { kind: "attach", runtimeId: HOST_ID });
  });

  it("keeps the draft's reason while it reads the browser again", async () => {
    const host = coveredHost();
    auto.blocked = { reason: BROWSER_AUTO_START_COPY.draftHeld };
    await cardArrives(); await settleReading();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.draftHeld });
    // The reading went stale while the person kept writing.
    await advance(6_000);
    host.refreshHost.mockClear();
    auto.revision = "later";
    await render();
    expect(host.refreshHost).toHaveBeenCalledWith();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.draftHeld });
    await settleReading();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.draftHeld });
    expect(value.activate).not.toHaveBeenCalled();
  });

  it.each([
    ["a space where Studio leaves Instafy's browser to a press", () => {
      const now = new Date().toISOString();
      const runtimes = [{ runtimeId: "rt-1", status: "ready", provider: "instafy-cloud", displayName: "hosted runtime",
        health: "online", isLocal: false, lastSeenAt: now, idleTtlSeconds: 900, isPreferred: true, createdAt: now,
        origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] } }] as ControllerRuntimeStatusEntry[];
      value.transport = "shared"; value.personalAvailable = false;
      plan.mockImplementation((_request, transport) => browserAutoStartPlan({
        transport: transport as "shared", personalAvailable: false, personalOwnAi: false, projectId: "project-1", runtimes,
        sharedBrowserHostPolicy: "off", conversationRuntimeId: "rt-1", host: null, hostReadAtMs: null, nowMs: Date.now(),
      }));
    }, BROWSER_AUTO_START_COPY.restartsMachine],
    ["a person on Instafy AI", () => {
      plan.mockReturnValue({ kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi });
    }, BROWSER_AUTO_START_COPY.personalNeedsOwnAi],
    ["a failed host", () => { coveredHost({ state: "failed" }); }, BROWSER_AUTO_START_COPY.hostFailed],
    ["a browser someone else is using", () => { auto.heldByOther = true; }, BROWSER_AUTO_START_COPY.inUse],
  ] as const)("never says a draft holds a card that would not open by itself: %s", async (_name, arrange, reason) => {
    arrange();
    auto.blocked = { reason: BROWSER_AUTO_START_COPY.draftHeld };
    await cardArrives(); await settleReading();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason });
    auto.blocked = null;
    await render(); await settleReading();
    expect(value.activate).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason });
  });

  it.each([
    ["the person sends the draft", () => {
      value.messages = [...value.messages, { id: "reply", role: "user", authorId: "user-1", content: "Yes, go ahead", timestamp: Date.now() }];
      auto.blocked = null;
    }],
    ["a newer card arrives", () => {
      value.messages = [...value.messages, card("job-2")];
    }],
  ] as const)("drops the draft's reason when %s", async (_name, change) => {
    coveredHost();
    auto.blocked = { reason: BROWSER_AUTO_START_COPY.draftHeld };
    await cardArrives(); await settleReading();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.draftHeld });
    change();
    await render(); await settleReading(); await advance(5_000);
    expect(value.activate).not.toHaveBeenCalled();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: null });
  });

  it("shows how a press of a card a draft holds went, not the draft's reason", async () => {
    auto.blocked = { reason: BROWSER_AUTO_START_COPY.draftHeld };
    value.open = true; value.personalReady = true;
    value.continueTask = vi.fn(async () => false);
    await cardArrives();
    expect(lastState?.cardStates.get("job:job-1")).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.draftHeld });
    const detail: { messageId: string; completion?: Promise<unknown> } = { messageId: "card-job-1" };
    await act(async () => { window.dispatchEvent(new CustomEvent("instafy:request-browser", { detail })); });
    const completion = detail.completion?.catch(() => null);
    await advance(); await advance();
    await act(async () => { await completion; });
    expect(value.continueTask).toHaveBeenCalledTimes(1);
    expect(lastState?.cardStates.get("job:job-1")).toEqual({
      kind: "button",
      reason: "The browser task was not sent. You can retry from its message.",
    });
  });

  /** A first card opened Instafy's browser on the host and its task went out. */
  async function firstCardContinued() {
    const host = coveredHost();
    value.sharedHost = { runtimeId: HOST_ID, heldByOther: false };
    await cardArrives(); await settleReading();
    await openHost();
    expect(value.continueTask).toHaveBeenCalledTimes(1);
    return host;
  }
  /** A plain chat turn a minute later asks for the browser again. */
  async function secondCardArrives() {
    await advance(60_000);
    const prompt = sendPrompt({}, "job-2");
    value.messages = [...value.messages, prompt, card("job-2")];
    await render(); await advance(10);
    await settleReading();
  }

  it("continues a second card in the browser already open on the conversation's machine, without a press", async () => {
    await firstCardContinued();
    await secondCardArrives();
    expect(value.activate).toHaveBeenCalledTimes(2);
    expect(value.activate).toHaveBeenLastCalledWith("shared", { kind: "attach", runtimeId: HOST_ID });
    await advance(); await advance();
    expect(value.continueTask).toHaveBeenCalledTimes(2);
    expect(value.continueTask).toHaveBeenLastCalledWith("shared", expect.stringContaining(TASK), expect.objectContaining({
      metadata: { browserRequestOf: "job:job-2", browserAutoStarted: true },
    }));
    expect(lastState?.cardStates.get("job:job-2")).toEqual({ kind: "opened" });
  });

  it.each([
    ["the browser was closed", () => { value.open = false; markBrowserAutoStartDeclined(IDENTITY); }],
    ["the browser is closed", () => { value.open = false; }],
    ["the open browser is on another machine", () => { value.sharedRuntimeId = "other-runtime"; }],
  ] as const)("leaves a second card within ten minutes a button when %s", async (_name, change) => {
    await firstCardContinued();
    change();
    await render();
    await secondCardArrives();
    expect(value.activate).toHaveBeenCalledTimes(1);
    expect(value.continueTask).toHaveBeenCalledTimes(1);
    expect(lastState?.cardStates.get("job:job-2")).toEqual({ kind: "button", reason: null });
  });

  it("leaves a second card for the browser on this device a button within ten minutes, while Instafy's browser is open on the conversation's machine", async () => {
    await firstCardContinued();
    // The person is on their own AI in the desktop app: the plan would start
    // the browser on this device, which opens a browser of its own.
    value.personalAvailable = true;
    await render();
    await advance(60_000);
    const prompt = sendPrompt({}, "job-2");
    const deviceCard = card("job-2");
    deviceCard.metadata = { ...deviceCard.metadata,
      details: { browserRequest: { task: TASK, location: "device" } } };
    value.messages = [...value.messages, prompt, deviceCard];
    await render(); await advance(10); await settleReading();
    expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ task: TASK, location: "device" }), "personal");
    expect(plan.mock.results.at(-1)?.value).toEqual({ kind: "personal" });
    expect(value.activate).toHaveBeenCalledTimes(1);
    expect(lastState?.cardStates.get("job:job-2")).toEqual({ kind: "button", reason: null });
  });

  it("still never continues a card a browser turn sent, even into the open browser", async () => {
    await firstCardContinued();
    await advance(60_000);
    const prompt = sendPrompt({ browserTransport: "shared" }, "job-2");
    value.messages = [...value.messages, prompt, card("job-2")];
    await render(); await advance(10); await settleReading();
    expect(value.activate).toHaveBeenCalledTimes(1);
  });

  it("never asks the browser to attach again for an automatic start", async () => {
    const host = coveredHost({ state: "idle" });
    const reattach = vi.fn();
    value.sharedHost = { runtimeId: HOST_ID, refresh: host.refreshHost, reattach, heldByOther: false };
    await cardArrives(); await settleReading();
    expect(value.activate).toHaveBeenCalledTimes(1);
    host.snapshot = snapshot({ state: "idle" });
    value.transport = "shared"; value.open = true; value.sharedReady = false; value.sharedRuntimeId = HOST_ID;
    await render();
    await advance(20_000);
    expect(reattach).not.toHaveBeenCalled();
  });
});
