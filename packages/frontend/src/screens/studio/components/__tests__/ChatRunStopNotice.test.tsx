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
  it("allows retry after failed submission but considers queued continuation accepted", async () => {
    submit.mockResolvedValueOnce(false).mockImplementationOnce(async (_override, options) => { options?.onQueued?.(); return false; });
    await render(); expect(await controls!.onContinue(notice)).toBe(false);
    expect(controls!.canContinue(notice)).toBe(true);
    expect(await controls!.onContinue(notice)).toBe(true);
    expect(controls!.canContinue(notice)).toBe(false);
  });
});
