// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBrowserPause, useShowBrowserOnHumanInput, useShowBrowserOnRequest } from "../useShowBrowserOnRequest";
import { BROWSER_HUMAN_INPUT_CONTINUE_PROMPT, LET_OCTO_CONTINUE } from "../useBrowserHumanInput";
import type { ChatMessage } from "../../types";
import type { RunRecord } from "../../../../types";

describe("useShowBrowserOnRequest", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Harness({ open, token, show }: { open: boolean; token: number; show: () => void }) {
    useShowBrowserOnRequest(open, token, show);
    return null;
  }

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

  // Local drive, Oct 29: a card Studio opened by itself switched to the
  // Browser view. Only a press does now; Studio's own open stays in Chat.
  it("shows the browser once per request, and never for an open nobody asked to see", async () => {
    const show = vi.fn();
    const render = (open: boolean, token: number) => act(async () => root.render(<Harness open={open} token={token} show={show} />));
    // A press asks to show it: shown once the browser is open.
    await render(false, 1);
    expect(show).not.toHaveBeenCalled();
    await render(true, 1);
    expect(show).toHaveBeenCalledTimes(1);
    // The browser closes, and Studio opens it again by itself: no request.
    await render(false, 1);
    await render(true, 1);
    expect(show).toHaveBeenCalledTimes(1);
    // The next press shows it again.
    await render(true, 2);
    expect(show).toHaveBeenCalledTimes(2);
  });
});

describe("useShowBrowserOnHumanInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  type HarnessProps = { identity: string; userId: string; messages: ChatMessage[]; runs: RunRecord[]; show: () => void };
  function Harness(props: HarnessProps) {
    useShowBrowserOnHumanInput(props);
    return null;
  }

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

  const run = (id: string, jobId: string, initiatingUserId: string): RunRecord => ({
    id, projectId: "project-1", sessionId: null, conversationId: "chat-1", promptId: null, runType: "prompt",
    status: "success", progress: 1, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null, metadata: { jobId, initiatingUserId, browserTransport: "shared" },
  });
  const pause = (id: string, timestamp: number, jobId = "job-mine"): ChatMessage => ({
    id, role: "assistant", content: "Tool call completed", timestamp,
    metadata: { messageType: "mcp_tool_call", jobId, details: { tool: "request_human_input", status: "completed" } },
  });
  const reply = (id: string, timestamp: number): ChatMessage => ({ id, role: "assistant", content: "Done.", timestamp });
  const runs = [run("run-mine", "job-mine", "user-1"), run("run-theirs", "job-theirs", "user-2")];

  // Octo paused on a sign-in's fields, but Studio stayed in Chat, so the page
  // with the highlighted fields was not on screen. The pause brings it forward.
  it("shows the browser once when Octo pauses on the person's fields, never for history", async () => {
    const show = vi.fn();
    const render = (identity: string, messages: ChatMessage[]) =>
      act(async () => root.render(<Harness identity={identity} userId="user-1" messages={messages} runs={runs} show={show} />));
    const before = Date.now() - 60_000;
    // A pause from before the chat was opened here switches nothing.
    await render("chat-1", [pause("old", before), reply("r1", before + 1)]);
    expect(show).not.toHaveBeenCalled();
    // A new pause comes in: shown once.
    const now = Date.now();
    await render("chat-1", [pause("old", before), reply("r1", before + 1), pause("new", now)]);
    expect(show).toHaveBeenCalledTimes(1);
    await render("chat-1", [pause("old", before), reply("r1", before + 1), pause("new", now), reply("r2", now + 1)]);
    expect(show).toHaveBeenCalledTimes(1);
    // Another chat opened later: its earlier pause is history there.
    await render("chat-2", [pause("other", now - 5_000)]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  // In a team space every member reading a chat saw it: a pause in another
  // member's turn moved them onto that member's sign-in page.
  it("switches only the person whose turn paused", async () => {
    const show = vi.fn();
    const render = (userId: string, messages: ChatMessage[], knownRuns = runs) =>
      act(async () => root.render(<Harness identity={`chat-1:${userId}`} userId={userId} messages={messages} runs={knownRuns} show={show} />));
    const now = Date.now();
    await render("user-1", [pause("theirs", now, "job-theirs")]);
    expect(show).not.toHaveBeenCalled();
    // A pause whose turn is not known yet waits for it.
    await render("user-1", [pause("theirs", now, "job-theirs"), pause("mine", now, "job-new")]);
    expect(show).not.toHaveBeenCalled();
    await render("user-1", [pause("theirs", now, "job-theirs"), pause("mine", now, "job-new")],
      [...runs, run("run-new", "job-new", "user-1")]);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

// Dogfood, Nov 22: Octo paused on a sign-in in Instafy's browser. After a
// reload the next day its reply had no button and no Browser tab, as both
// came only from the browser's own record of the pause, which runs out
// after 10 minutes and lives on the space's machine. The chat's own record
// of it says whether it still waits.
describe("openBrowserPause", () => {
  const HOUR_AGO = Date.now() - 60 * 60_000;
  const run = (
    id: string,
    jobId: string,
    initiatingUserId: string,
    metadata: Record<string, unknown> = {},
  ): RunRecord => ({
    id, projectId: "project-1", sessionId: null, conversationId: "chat-1", promptId: null, runType: "prompt",
    status: "success", progress: 1, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null,
    metadata: {
      jobId, initiatingUserId, browserTransport: "shared", browserRuntimeId: "runtime-1", browserPageId: "PAGE1",
      ...metadata,
    },
  });
  const prompt = (id: string, timestamp: number, metadata: Record<string, unknown> = {}): ChatMessage => ({
    id, role: "user", content: "Sign in to my accounting site and list last month's invoices", timestamp, metadata,
  });
  const step = (id: string, timestamp: number, details: Record<string, unknown>, jobId = "job-mine"): ChatMessage => ({
    id, role: "assistant", content: "Tool call completed", timestamp,
    metadata: { messageType: "mcp_tool_call", jobId, details: { server: "instafy_shared_browser", ...details } },
  });
  const signInPause = (id: string, timestamp: number, jobId = "job-mine") => step(id, timestamp, {
    tool: "request_human_input", status: "completed",
    terminalConsent: { state: "blocked", terminal: true, retryable: false, code: "human_input_required" },
  }, jobId);
  const reply = (id: string, timestamp: number, jobId = "job-mine"): ChatMessage => ({
    id, role: "assistant", timestamp, metadata: { jobId },
    content: "Sign in or fill in the highlighted fields on the page in Instafy's browser, then choose Let Octo continue.",
  });
  const runs = [run("run-mine", "job-mine", "user-1"), run("run-theirs", "job-theirs", "user-2")];
  const pausedChat = [prompt("p1", HOUR_AGO - 5_000), signInPause("pause", HOUR_AGO), reply("r1", HOUR_AGO + 1_000)];

  it("finds a pause from before the chat was opened while it is still the chat's last word", () => {
    expect(openBrowserPause(pausedChat, runs, "user-1")).toEqual({
      messageId: "pause", runId: "run-mine", runtimeId: "runtime-1", pageId: "PAGE1",
    });
    // The run's own id finds it too, when the message names one.
    const byRunId = { ...pausedChat[1], metadata: { ...pausedChat[1].metadata, jobId: undefined, runId: "run-mine" } };
    expect(openBrowserPause([pausedChat[0], byRunId, pausedChat[2]], runs, "user-1")?.runId).toBe("run-mine");
  });

  it("closes once the person writes again, Let Octo continue's press too", () => {
    const later = HOUR_AGO + 60_000;
    expect(openBrowserPause([...pausedChat, prompt("p2", later)], runs, "user-1")).toBeNull();
    const press = prompt("press", later, { dispatchContent: BROWSER_HUMAN_INPUT_CONTINUE_PROMPT });
    expect(openBrowserPause([...pausedChat, { ...press, content: LET_OCTO_CONTINUE }], runs, "user-1")).toBeNull();
    // A teammate's message is a person writing too: the chat has moved on.
    expect(openBrowserPause([...pausedChat, { ...prompt("p3", later), authorId: "user-2" }], runs, "user-1")).toBeNull();
    // The press's own turn pausing again waits again.
    const again = [...pausedChat, press, signInPause("pause-2", later + 5_000, "job-again")];
    expect(openBrowserPause(again, [...runs, run("run-again", "job-again", "user-1")], "user-1")?.messageId).toBe("pause-2");
  });

  it("is none of another member's business, nor of a viewer not signed in", () => {
    const theirs = [prompt("p1", HOUR_AGO - 5_000), signInPause("pause", HOUR_AGO, "job-theirs"), reply("r1", HOUR_AGO + 1_000, "job-theirs")];
    expect(openBrowserPause(theirs, runs, "user-1")).toBeNull();
    expect(openBrowserPause(theirs, runs, "user-2")?.runId).toBe("run-theirs");
    expect(openBrowserPause(pausedChat, runs, null)).toBeNull();
  });

  it("ends with a Stop of its turn", () => {
    const stop: ChatMessage = {
      id: "stop", role: "assistant", content: "Stopped this run.", timestamp: HOUR_AGO + 2_000,
      metadata: { source: "controller", kind: "run_cancellation",
        details: { stopRequested: true, actorUserId: "user-1", runIds: ["run-mine"], jobIds: ["job-mine"] } },
    };
    expect(openBrowserPause([...pausedChat, stop], runs, "user-1")).toBeNull();
    // A take-over's notice records no Stop: the pause goes on.
    const takeOver = { ...stop, metadata: { ...stop.metadata, details: { stopRequested: false, runIds: ["run-mine"] } } };
    expect(openBrowserPause([...pausedChat, takeOver], runs, "user-1")?.messageId).toBe("pause");
  });

  it("is only Instafy's browser's: a pause in this device's own browser has its own way back", () => {
    const personal = [run("run-mine", "job-mine", "user-1", { browserTransport: "desktop-personal" })];
    expect(openBrowserPause(pausedChat, personal, "user-1")).toBeNull();
    const unknown = [run("run-mine", "job-mine", "user-1", { browserTransport: undefined })];
    expect(openBrowserPause(pausedChat, unknown, "user-1")).toBeNull();
  });

  it("counts a pause on a cookie notice or on a step only the person takes", () => {
    for (const code of ["cookie_notice_required", "human_step_required"]) {
      const pause = step("pause", HOUR_AGO, { tool: "click", status: "completed",
        terminalConsent: { state: "blocked", terminal: true, retryable: false, code } });
      expect(openBrowserPause([pausedChat[0], pause, pausedChat[2]], runs, "user-1")?.messageId).toBe("pause");
    }
    // A step the person said no to is an answer, not a pause.
    const denied = step("denied", HOUR_AGO, { tool: "click", status: "failed",
      terminalConsent: { state: "blocked", terminal: true, retryable: false, code: "approval_denied" } });
    expect(openBrowserPause([pausedChat[0], denied, pausedChat[2]], runs, "user-1")).toBeNull();
    // A pause still being written is not one yet.
    const starting = step("starting", HOUR_AGO, { tool: "request_human_input", status: "in_progress", terminalConsent: null });
    expect(openBrowserPause([pausedChat[0], starting], runs, "user-1")).toBeNull();
  });

  it("waits for its run: a pause in a turn not known yet leads nowhere", () => {
    expect(openBrowserPause(pausedChat, [run("run-other", "job-other", "user-1")], "user-1")).toBeNull();
    expect(openBrowserPause(pausedChat, [], "user-1")).toBeNull();
  });

  it("reads only the newest pause: an older one before the person's next message is over", () => {
    const later = HOUR_AGO + 60_000;
    const chat = [...pausedChat, prompt("p2", later), reply("r2", later + 1_000, "job-next")];
    expect(openBrowserPause(chat, [...runs, run("run-next", "job-next", "user-1")], "user-1")).toBeNull();
  });
});
