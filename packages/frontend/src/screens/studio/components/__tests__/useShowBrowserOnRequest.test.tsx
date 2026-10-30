// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShowBrowserOnHumanInput, useShowBrowserOnRequest } from "../useShowBrowserOnRequest";
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
