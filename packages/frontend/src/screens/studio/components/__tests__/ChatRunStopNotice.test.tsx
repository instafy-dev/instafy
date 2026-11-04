// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { ChatRunStopNotice, ChatRunStopNoticeProvider, chatRunStopNoticeText } from "../ChatRunStopNotice";
import { useChatRunStopContinuation } from "../useChatRunStopContinuation";
import type { SubmitMessageFn } from "../useChatSubmitFlow";

const notice: ChatMessage = {
  id: "stop-1", role: "assistant", authorId: null, content: "", timestamp: 1, files: null,
  messageType: "run_cancellation", metadata: { details: {
    stopRequested: true, actorUserId: "viewer", agentHandles: ["octo", "scribe"],
    jobIds: ["job-1", "job-2"], runIds: ["run-1", "run-2"],
  } },
};

describe("persisted run stop notice", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controls: ReturnType<typeof useChatRunStopContinuation>;
  const submit = vi.fn<SubmitMessageFn>();
  let props: Parameters<typeof useChatRunStopContinuation>[0];
  function Harness() {
    controls = useChatRunStopContinuation(props);
    return <ChatRunStopNoticeProvider value={controls}><ChatRunStopNotice message={notice} /></ChatRunStopNoticeProvider>;
  }
  async function render(next: Partial<typeof props> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    submit.mockReset();
    props = { conversationId: "chat", viewerUserId: "viewer", humanLabelByUserId: new Map(), canWrite: true,
      busy: false, messages: [notice], queuedSends: [], submitMessage: submit };
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("attributes the request without claiming that the executor has exited", () => {
    expect(chatRunStopNoticeText(notice, "viewer")).toBe("You asked Octo and @scribe to stop.");
    expect(chatRunStopNoticeText(notice, "other", new Map([["viewer", "Alex"]]))).toBe("Alex asked Octo and @scribe to stop.");
    expect(chatRunStopNoticeText({ ...notice, metadata: null }, "viewer")).toBe("Run stopped.");
  });
  it("continues with a fresh targeted instruction, preserving the draft and preventing duplicate sends", async () => {
    submit.mockResolvedValue(true); await render();
    await act(async () => { await controls!.onContinue(notice); await controls!.onContinue(notice); });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentHandles: ["octo", "scribe"],
      message: expect.stringContaining("do not repeat completed actions"),
      metadata: { continuedStopMessageId: "stop-1", continuedRunIds: ["run-1", "run-2"] },
    }), expect.objectContaining({ automatic: true, intent: "send" }));
  });
  it("hides Continue while busy or read-only and rechecks capability on activation", async () => {
    await render({ busy: true }); expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).toBeNull();
    await render({ busy: false, canWrite: false }); await controls!.onContinue(notice); expect(submit).not.toHaveBeenCalled();
    await render({ canWrite: true }); expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).not.toBeNull();
    await render({ conversationId: "other-chat", messages: [] }); await controls!.onContinue(notice); expect(submit).not.toHaveBeenCalled();
  });
  it("does not offer Continue for legacy notices or a persisted continuation", async () => {
    await render(); expect(controls!.canContinue({ ...notice, metadata: null })).toBe(false);
    await render({ messages: [notice, { ...notice, id: "follow-up", metadata: { continuedStopMessageId: notice.id } }] });
    expect(controls!.canContinue(notice)).toBe(false);
  });
  // A local test, Nov 3: the person undid the stopped turn's edit, and the row still
  // offered Continue, which would put the undone change back.
  it("does not offer Continue once the person undid what the stopped turn changed", async () => {
    const undone: ChatMessage = {
      id: "undo-line", role: "assistant", authorId: null, timestamp: 2, files: null,
      content: "The person undid the change from “Add a section.”",
      metadata: { source: "controller", kind: "change_undone", presentation: { hidden: true },
        undoneMessageId: "files-1", undoneRunId: "run-2" },
    };
    await render({ messages: [notice, undone] });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(container.querySelector('[data-testid="chat-run-stop-continue"]')).toBeNull();
    // Another run's Undo leaves this one's Continue, and so does a message
    // that only calls itself an Undo's line (no controller source).
    await render({ messages: [notice, { ...undone, metadata: { ...undone.metadata, undoneRunId: "run-9" } }] });
    expect(controls!.canContinue(notice)).toBe(true);
    await render({ messages: [notice, { ...undone, metadata: { ...undone.metadata, source: "client" } }] });
    expect(controls!.canContinue(notice)).toBe(true);
  });
  // A local test, Nov 4: the row of a turn stopped before it changed anything
  // still offered Continue after two later turns had finished, and again
  // after a reload.
  it("offers Continue only on the chat's latest turn", async () => {
    const asked = (id: string, timestamp: number): ChatMessage => ({
      id, role: "user", authorId: "viewer", content: "Add a one-line tip.", timestamp, files: null,
    });
    const replied = (id: string, timestamp: number, jobId: string): ChatMessage => ({
      id, role: "assistant", authorId: null, content: "Added the tip.", timestamp, files: null,
      metadata: { jobId },
    });
    const continueButton = () => container.querySelector('[data-testid="chat-run-stop-continue"]');
    // The stopped turn's own late rows and the lines nobody wrote keep it
    // the latest.
    const ownLateRow = replied("late", 2, "job-2");
    const hiddenLine: ChatMessage = {
      id: "hidden", role: "assistant", authorId: null, content: "The person undid the change from “…”", timestamp: 3,
      files: null, metadata: { source: "controller", kind: "change_undone", presentation: { hidden: true },
        undoneMessageId: "other", undoneRunId: "run-9" },
    };
    await render({ messages: [notice, ownLateRow, hiddenLine] });
    expect(controls!.canContinue(notice)).toBe(true);
    expect(continueButton()).not.toBeNull();

    // Then the person asked for something else, and that turn finished.
    const later = [notice, ownLateRow, hiddenLine, asked("next", 4), replied("next-reply", 5, "job-3")];
    await render({ messages: later });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(continueButton()).toBeNull();
    // After a reload the chat holds the same messages: still no Continue.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ messages: [...later] });
    expect(continueButton()).toBeNull();
    // A later stopped turn is the latest one: its row offers Continue.
    const laterStop: ChatMessage = { ...notice, id: "stop-2", timestamp: 6, metadata: { details: {
      stopRequested: true, actorUserId: "viewer", agentHandles: ["octo"], jobIds: ["job-4"], runIds: ["run-4"],
    } } };
    await render({ messages: [...later, asked("again", 6), laterStop] });
    expect(controls!.canContinue(notice)).toBe(false);
    expect(controls!.canContinue(laterStop)).toBe(true);
  });
  it("allows retry after failed submission but considers queued continuation accepted", async () => {
    submit.mockResolvedValueOnce(false).mockImplementationOnce(async (_override, options) => { options?.onQueued?.(); return false; });
    await render(); expect(await controls!.onContinue(notice)).toBe(false);
    expect(controls!.canContinue(notice)).toBe(true);
    expect(await controls!.onContinue(notice)).toBe(true);
    expect(controls!.canContinue(notice)).toBe(false);
  });
});
