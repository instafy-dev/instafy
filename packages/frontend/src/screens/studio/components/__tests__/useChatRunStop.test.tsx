// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerConversationStopResult } from "../../../../services/runtimeController/conversationStop";

vi.mock("../../../../services/runtimeController/conversationStop", () => ({ stopConversationJobs: vi.fn() }));
import { applyReplyDraft, clearReplyDrafts, conversationReplyDrafts } from "../../../../conversations/replyDrafts";
import { RuntimeStateProvider, useRuntimeState } from "../../../../runtime/RuntimeStateProvider";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { ChatRunStopControl } from "../ChatRunStopControl";
import { chatRunStopEndedIds, resolveChatRunStopTargets } from "../chatRunStopTargets";
import {
  CHAT_RUN_STOP_HANDOVER_MS, CHAT_RUN_STOP_TIMEOUT_MS, useChatRunStop, type ChatRunStopController, type ChatRunStopOptions,
  type ChatRunStopTarget,
} from "../useChatRunStop";

const octo: ChatRunStopTarget = { jobId: "octo-1", runId: "r1", agentHandle: "octo", agentDisplayName: "Octo", initiatingUserId: "viewer" };
const scribe: ChatRunStopTarget = { jobId: "scribe-1", runId: "r2", agentHandle: "scribe", agentDisplayName: "Scribe", initiatingUserId: "viewer" };
function accepted(...ids: string[]): ControllerConversationStopResult {
  return { ok: true, canceledJobIds: ids, canceledRunIds: [], alreadyFinishedJobIds: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("useChatRunStop", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: ChatRunStopController;
  let props: ChatRunStopOptions;
  const cancel = vi.fn<NonNullable<ChatRunStopOptions["cancelJobs"]>>();
  function Harness() { controller = useChatRunStop(props); return null; }
  async function render(next: Partial<ChatRunStopOptions> = {}) {
    props = { ...props, ...next };
    await act(async () => { root.render(<Harness />); });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    props = { conversationId: "chat", targets: [octo], viewerUserId: "viewer", canStop: true, cancelJobs: cancel };
    cancel.mockReset();
  });
  afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); });

  it("offers Stop before any command and only with write capability in the chat", async () => {
    await render(); expect(controller!.visible).toBe(true);
    await render({ canStop: false }); expect(controller!.visible).toBe(false);
    await act(async () => controller!.requestStop()); expect(cancel).not.toHaveBeenCalled();
  });
  it("freezes exact IDs, prevents duplicate presses, and distinguishes acceptance from physical stopping", async () => {
    const pending = deferred<ControllerConversationStopResult>(); cancel.mockReturnValue(pending.promise);
    const onStopped = vi.fn(); await render({ onStopped });
    await act(async () => { controller!.requestStop(); controller!.requestStop(); });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["octo-1"]); expect(controller!.phase).toBe("stopping");
    await act(async () => pending.resolve(accepted("octo-1")));
    expect(controller!.phase).toBe("requested"); expect(onStopped).toHaveBeenCalledWith(accepted("octo-1"), [octo]);
    await render({ targets: [] }); expect(controller!.visible).toBe(false);
    await render({ targets: [{ ...octo, jobId: "replacement" }] }); expect(controller!.phase).toBe("idle"); expect(controller!.visible).toBe(true);
  });
  it.each(["another-person", null])("requires confirmation for owner %s and preserves the chosen jobs", async (owner) => {
    cancel.mockResolvedValue(accepted("octo-1"));
    await render({ targets: [{ ...octo, initiatingUserId: owner }] });
    await act(async () => controller!.requestStop()); expect(cancel).not.toHaveBeenCalled();
    expect(controller!.confirmationTargets?.map((target) => target.jobId)).toEqual(["octo-1"]);
    await render({ targets: [scribe] });
    await act(async () => controller!.confirmStop());
    expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["octo-1"]);
  });
  it("stops one agent group and leaves another agent available", async () => {
    cancel.mockResolvedValue(accepted("octo-1")); await render({ targets: [octo, scribe] });
    await act(async () => controller!.requestStop(controller!.groups[0].targets));
    expect(cancel).toHaveBeenCalledWith("chat", ["octo-1"]);
    expect(controller!.phase).toBe("idle"); expect(controller!.targets).toEqual([scribe]);
  });
  it("retries only unacknowledged jobs after partial success", async () => {
    cancel.mockResolvedValueOnce(accepted("octo-1")).mockResolvedValueOnce(accepted("scribe-1"));
    await render({ targets: [octo, scribe] }); await act(async () => controller!.requestStop());
    expect(controller!.phase).toBe("error");
    await act(async () => controller!.retry()); expect(cancel).toHaveBeenLastCalledWith("chat", ["scribe-1"]);
  });
  it("times out honestly and retries the original job rather than a replacement", async () => {
    cancel.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce({ ...accepted(), alreadyFinishedJobIds: ["octo-1"] });
    await render(); await act(async () => controller!.requestStop());
    await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_TIMEOUT_MS));
    expect(controller!.phase).toBe("error"); expect(controller!.error).toContain("may still take effect");
    await render({ targets: [{ ...octo, jobId: "replacement" }] });
    await act(async () => controller!.retry()); expect(cancel).toHaveBeenLastCalledWith("chat", ["octo-1"]);
    expect(controller!.targets.map((target) => target.jobId)).toEqual(["replacement"]);
  });
  it("does not claim success on a rejected response or fallback to another endpoint", async () => {
    cancel.mockResolvedValue({ ...accepted("octo-1"), ok: false }); await render();
    await act(async () => controller!.requestStop()); expect(controller!.phase).toBe("error"); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not carry late operation state into another conversation", async () => {
    const pending = deferred<ControllerConversationStopResult>(); cancel.mockReturnValue(pending.promise);
    const onStopped = vi.fn(); await render({ onStopped }); await act(async () => controller!.requestStop());
    await render({ conversationId: "other-chat", targets: [scribe] });
    await act(async () => pending.resolve(accepted("octo-1")));
    expect(controller!.phase).toBe("idle"); expect(onStopped).not.toHaveBeenCalled();
  });
  it("rechecks capability before a confirmation or retry", async () => {
    await render({ targets: [{ ...octo, initiatingUserId: null }] }); await act(async () => controller!.requestStop());
    await render({ canStop: false }); await act(async () => controller!.confirmStop()); expect(cancel).not.toHaveBeenCalled();
  });
  it("Esc stops the captured set, while a dismissed overlay owns its first Escape", async () => {
    cancel.mockResolvedValue(accepted("octo-1", "scribe-1")); await render({ targets: [octo, scribe] });
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.appendChild(dialog);
    const dismiss = () => dialog.remove(); document.addEventListener("keydown", dismiss, { once: true });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await vi.runAllTicks(); });
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await vi.runAllTicks(); });
    expect(cancel).toHaveBeenCalledWith("chat", ["octo-1", "scribe-1"]);
  });
  it("does not handle Escape consumed by a later window handler", async () => {
    await render(); const listener = (event: KeyboardEvent) => event.preventDefault(); window.addEventListener("keydown", listener);
    try {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await vi.runAllTicks(); });
      expect(cancel).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", listener); }
  });
  it("allows Escape for a replacement job after an accepted job disappears", async () => {
    cancel.mockResolvedValueOnce(accepted("octo-1")).mockResolvedValueOnce(accepted("replacement"));
    await render(); await act(async () => controller!.requestStop()); expect(controller!.phase).toBe("requested");
    await render({ targets: [{ ...octo, jobId: "replacement" }] });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await vi.runAllTicks(); });
    expect(cancel).toHaveBeenLastCalledWith("chat", ["replacement"]);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  // The chat's Browser view keeps Escape for the browser, and a sign-in pause
  // brings that view forward by itself while Stop stays: there Stop's words
  // don't offer Escape, which stops nothing, while Chat keeps both.
  it("offers Escape in Stop's words only where Escape stops", async () => {
    function WithControl() { controller = useChatRunStop(props); return <ChatRunStopControl controller={controller} />; }
    const stopButton = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-run-stop-button"]')!;
    const escape = () => act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await vi.runAllTicks();
    });
    props = { ...props, escapeStops: false };
    await act(async () => { root.render(<WithControl />); });
    expect(stopButton().title).toBe("Stop");
    await escape();
    expect(cancel).not.toHaveBeenCalled();
    // A press still stops the turn there.
    cancel.mockResolvedValueOnce(accepted("octo-1"));
    await act(async () => stopButton().click());
    expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["octo-1"]);
    // In Chat, for the next turn.
    cancel.mockReset(); cancel.mockResolvedValueOnce(accepted("octo-2"));
    props = { ...props, escapeStops: true, targets: [{ ...octo, jobId: "octo-2" }] };
    await act(async () => { root.render(<WithControl />); });
    expect(stopButton().title).toBe("Stop (Esc)");
    await escape();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["octo-2"]);
  });

  // A local test, Nov 17: a pause on the person's sign-in fields brought the
  // chat's Browser view forward by itself, and Stop went with the Chat view,
  // while the turn that paused went on writing its reply for 14 s.
  it("stays in the chat's Browser view through a pause, until the turn that paused ends", async () => {
    const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
    const pausing = (status: RunRecord["status"]): RunRecord => ({
      id: "r1", status, projectId: "project", sessionId: null, conversationId: "chat", promptId: null, runType: "prompt",
      progress: 0, progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
      metadata: { jobId: JOB, initiatingUserId: "viewer", agent: { handle: "octo" }, browserTransport: "shared" },
    });
    const pause = { id: "m1", role: "assistant", content: "Tool call completed: instafy_shared_browser/request_human_input",
      timestamp: 1, metadata: { runId: "r1", jobId: JOB, type: "mcp_tool_call",
        details: { tool: "request_human_input", status: "completed" } } } as unknown as ChatMessage;
    await render({ targets: resolveChatRunStopTargets([pausing("in_progress")], [pause]) });
    expect(controller!.visible).toBe(true);
    // The turn ends by itself: Stop goes.
    await render({ targets: resolveChatRunStopTargets([pausing("success")], [pause]) });
    await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS));
    expect(controller!.visible).toBe(false);
    // A press before then stops that turn.
    cancel.mockResolvedValueOnce(accepted(JOB));
    await render({ targets: resolveChatRunStopTargets([pausing("in_progress")], [pause]) });
    await act(async () => controller!.requestStop());
    expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", [JOB]);
  });

  // Local tests, Nov 19 and 20: a note sent with the chat's map in front, and
  // a change sent with one of its pages in front, had no Stop at any moment
  // of their turns, so neither could be stopped. Stop follows the message's
  // turns alone, from Enter to the reply, and takes no view to follow (that
  // the chat gives it none is held in chatRunStopTargets.test.ts).
  it("stays from Enter to the reply, through the gap between a message's parts", async () => {
    // Enter: the message's turn is queued, then runs.
    await render({ targets: [octo] });
    expect(controller!.visible).toBe(true);
    // Between two of its parts (a browser part, then its build).
    await render({ targets: [], between: true });
    expect(controller!.visible).toBe(true);
    const build: ChatRunStopTarget = { ...octo, jobId: "build-1", runId: "r4" };
    await render({ targets: [build], between: false });
    expect(controller!.visible).toBe(true);
    // A press there stops it at once.
    cancel.mockResolvedValueOnce(accepted("build-1"));
    await act(async () => controller!.requestStop());
    expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["build-1"]);
    // Unpressed, it goes with the reply.
    cancel.mockClear();
    await render({ conversationId: "chat-2", targets: [octo] });
    expect(controller!.visible).toBe(true);
    await render({ conversationId: "chat-2", targets: [] });
    await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS));
    expect(controller!.visible).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  // A local test, Nov 10: between a message's routing step and its browser
  // turn there was nothing to press for 3.35 s, and 0.36 s between the
  // browser turn and its build. Stop stays through those gaps, and a press
  // there stops the part that comes next as it starts.
  describe("between two parts of a message", () => {
    const browserTurn: ChatRunStopTarget = { ...octo, jobId: "browser-1", runId: "r3" };

    it("keeps Stop for a moment after a turn ends by itself, then lets it go when nothing follows", async () => {
      await render();
      await render({ targets: [] });
      expect(controller!.visible).toBe(true);
      expect(controller!.phase).toBe("idle");
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS));
      expect(controller!.visible).toBe(false);
    });

    it("keeps Stop for as long as the next part is on its way", async () => {
      await render();
      await render({ targets: [], between: true });
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS * 10));
      expect(controller!.visible).toBe(true);
      await render({ between: false });
      expect(controller!.visible).toBe(false);
    });

    it("stops the part that goes on by itself as soon as it starts", async () => {
      cancel.mockResolvedValue(accepted("browser-1"));
      await render({ targets: [], between: true });
      await act(async () => controller!.requestStop());
      // Nothing runs yet: nothing is asked of the controller, and Stop says it is stopping.
      expect(cancel).not.toHaveBeenCalled();
      expect(controller!.visible).toBe(true);
      expect(controller!.phase).toBe("stopping");
      await render({ targets: [browserTurn], followOnTargets: [browserTurn], between: false });
      expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["browser-1"]);
      expect(controller!.phase).toBe("requested");
    });

    it("works the same from Escape, and in the moment after a turn ends by itself", async () => {
      cancel.mockResolvedValue(accepted("browser-1"));
      await render();
      await render({ targets: [] });
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await vi.runAllTicks(); });
      expect(controller!.phase).toBe("stopping");
      await render({ targets: [browserTurn], followOnTargets: [browserTurn] });
      expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["browser-1"]);
    });

    it("never stops a message someone sends meanwhile, and lets go once nothing more comes", async () => {
      const own: ChatRunStopTarget = { ...octo, jobId: "own-1", runId: "r4" };
      await render({ targets: [], between: true });
      await act(async () => controller!.requestStop());
      // The person wrote: their turn starts, and the next part never does.
      await render({ targets: [own], followOnTargets: [], between: false });
      expect(cancel).not.toHaveBeenCalled();
      expect(controller!.phase).toBe("idle");
      expect(controller!.targets).toEqual([own]);
    });

    it("asks before it stops a part someone else started", async () => {
      const theirs: ChatRunStopTarget = { ...browserTurn, initiatingUserId: "another-person" };
      await render({ targets: [], between: true });
      await act(async () => controller!.requestStop());
      await render({ targets: [theirs], followOnTargets: [theirs], between: false });
      expect(cancel).not.toHaveBeenCalled();
      expect(controller!.confirmationTargets?.map((target) => target.jobId)).toEqual(["browser-1"]);
    });

    it("keeps no Stop in another chat opened as a turn of this one runs", async () => {
      await render();
      await render({ conversationId: "other-chat", targets: [] });
      expect(controller!.visible).toBe(false);
    });

    it("keeps no Stop after a turn the Stop itself ended", async () => {
      cancel.mockResolvedValue(accepted("octo-1"));
      await render();
      await act(async () => controller!.requestStop());
      await render({ targets: [] });
      expect(controller!.visible).toBe(false);
    });
  });

  // A local test, Nov 22: after every Stop, Stop and "A reply is in progress.
  // Stop is available" came back for 0.5 to 1.5 s once the turn's row read
  // "Stopped". The turn's run record and the chat's notice of the Stop
  // reached the chat 20 to 90 ms before the Stop's own answer, so the turn
  // left the targets with nothing yet accepted: Stop read it as a turn that
  // ended by itself and kept its place for a next part of the message
  // (CHAT_RUN_STOP_HANDOVER_MS, longer while the page's timers ran late).
  describe("once the turn's row reads Stopped", () => {
    it("is gone, though the run's record comes before the Stop's answer", async () => {
      const pending = deferred<ControllerConversationStopResult>(); cancel.mockReturnValue(pending.promise);
      await render();
      await act(async () => controller!.requestStop());
      expect(controller!.phase).toBe("stopping");
      // The run's record says canceled: the row reads "Stopped".
      await render({ targets: [], stopped: new Set(["r1"]) });
      expect(controller!.visible).toBe(false);
      await act(async () => pending.resolve(accepted("octo-1")));
      expect(controller!.visible).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS));
      expect(controller!.visible).toBe(false);
    });

    it("is gone when the chat's notice of the Stop comes first, naming the turn's job", async () => {
      const pending = deferred<ControllerConversationStopResult>(); cancel.mockReturnValue(pending.promise);
      await render();
      await act(async () => controller!.requestStop());
      await render({ targets: [], stopped: new Set(["octo-1"]) });
      await act(async () => pending.resolve(accepted("octo-1")));
      expect(controller!.visible).toBe(false);
    });

    it("is gone after a Stop pressed between two parts, once the part it stopped reads Stopped", async () => {
      const build: ChatRunStopTarget = { ...octo, jobId: "build-1", runId: "r4" };
      const pending = deferred<ControllerConversationStopResult>(); cancel.mockReturnValue(pending.promise);
      await render({ targets: [], between: true });
      await act(async () => controller!.requestStop());
      await render({ targets: [build], followOnTargets: [build], between: false });
      expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["build-1"]);
      await render({ targets: [], followOnTargets: [], stopped: new Set(["r4", "build-1"]) });
      expect(controller!.visible).toBe(false);
      await act(async () => pending.resolve(accepted("build-1")));
      expect(controller!.visible).toBe(false);
    });

    it("is gone at once after someone else's Stop, which answers nothing here", async () => {
      const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
      const running: RunRecord = {
        id: "r1", status: "in_progress", projectId: "project", sessionId: null, conversationId: "chat", promptId: null,
        runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
        metadata: { jobId: JOB, initiatingUserId: "another-person", agent: { handle: "octo" } },
      };
      const notice = { id: "n1", role: "assistant", content: "Stopped this run.", timestamp: 2, metadata: {
        source: "controller", kind: "run_cancellation", runId: "r1",
        details: { stopRequested: true, actorUserId: "another-person", runIds: ["r1"], jobIds: [JOB] },
      } } as unknown as ChatMessage;
      await render({ targets: resolveChatRunStopTargets([running], []) });
      expect(controller!.visible).toBe(true);
      // The notice is in, the run's own record not yet: the row reads "Stopped".
      await render({ targets: resolveChatRunStopTargets([running], [notice]), stopped: chatRunStopEndedIds([running], [notice]) });
      expect(controller!.visible).toBe(false);
      // Then the record.
      const canceled = { ...running, status: "canceled" as const };
      await render({ targets: resolveChatRunStopTargets([canceled], [notice]), stopped: chatRunStopEndedIds([canceled], [notice]) });
      expect(controller!.visible).toBe(false);
    });

    it("offers no Retry for a Stop whose turn reads Stopped, though its answer never came", async () => {
      cancel.mockReturnValueOnce(new Promise(() => undefined));
      await render();
      await act(async () => controller!.requestStop());
      await render({ targets: [], stopped: new Set(["r1"]) });
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_TIMEOUT_MS));
      expect(controller!.visible).toBe(false);
      expect(controller!.error).toBeNull();
      // The next turn's Stop is a Stop of that turn, not a Retry of the last.
      const next: ChatRunStopTarget = { ...octo, jobId: "octo-2", runId: "r2" };
      await render({ targets: [next], stopped: new Set(["r1"]) });
      expect(controller!.visible).toBe(true);
      expect(controller!.phase).toBe("idle");
      cancel.mockResolvedValueOnce(accepted("octo-2"));
      await act(async () => controller!.requestStop());
      expect(cancel).toHaveBeenLastCalledWith("chat", ["octo-2"]);
    });

    it("still stays between two parts of a message, whatever else was stopped", async () => {
      const earlier = new Set(["r0", "octo-0"]);
      // A turn that ends by itself: Stop keeps its place for a next part.
      await render({ stopped: earlier });
      await render({ targets: [], stopped: earlier });
      expect(controller!.visible).toBe(true);
      expect(controller!.phase).toBe("idle");
      // The next part is on its way: Stop stays as long.
      await render({ targets: [], between: true, stopped: earlier });
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS * 10));
      expect(controller!.visible).toBe(true);
      // A press there stops that part as it starts.
      const build: ChatRunStopTarget = { ...octo, jobId: "build-1", runId: "r4" };
      cancel.mockResolvedValueOnce(accepted("build-1"));
      await act(async () => controller!.requestStop());
      expect(controller!.visible).toBe(true);
      expect(controller!.phase).toBe("stopping");
      await render({ targets: [build], followOnTargets: [build], between: false, stopped: earlier });
      expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", ["build-1"]);
    });

    it("still stays through a pause on the person's fields, until a Stop ends the turn that paused", async () => {
      const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
      const pausing: RunRecord = {
        id: "r1", status: "in_progress", projectId: "project", sessionId: null, conversationId: "chat", promptId: null,
        runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null,
        metadata: { jobId: JOB, initiatingUserId: "viewer", agent: { handle: "octo" }, browserTransport: "shared" },
      };
      const pause = { id: "m1", role: "assistant", content: "Tool call completed: instafy_shared_browser/request_human_input",
        timestamp: 1, metadata: { runId: "r1", jobId: JOB, type: "mcp_tool_call",
          details: { tool: "request_human_input", status: "completed" } } } as unknown as ChatMessage;
      const earlierNotice = { id: "n0", role: "assistant", content: "Stopped this run.", timestamp: 0, metadata: {
        source: "controller", kind: "run_cancellation", runId: "r0", details: { stopRequested: true, runIds: ["r0"], jobIds: ["octo-0"] },
      } } as unknown as ChatMessage;
      const chat = [earlierNotice, pause];
      await render({ targets: resolveChatRunStopTargets([pausing], chat), stopped: chatRunStopEndedIds([pausing], chat) });
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_HANDOVER_MS * 10));
      expect(controller!.visible).toBe(true);
      expect(controller!.targets.map((target) => target.jobId)).toEqual([JOB]);
      // The person's Stop is answered, and the run's record follows: Stop goes with it.
      cancel.mockResolvedValueOnce(accepted(JOB));
      await act(async () => controller!.requestStop());
      expect(cancel).toHaveBeenCalledExactlyOnceWith("chat", [JOB]);
      expect(controller!.phase).toBe("requested");
      const canceled = { ...pausing, status: "canceled" as const };
      await render({ targets: resolveChatRunStopTargets([canceled], chat), stopped: chatRunStopEndedIds([canceled], chat) });
      expect(controller!.visible).toBe(false);
    });
  });

  // A local test, Nov 7: the controller committed a Stop 42 ms after the
  // press and answered, and the turn's row said "Stopped" 495 ms after that,
  // once the run's own record arrived on its stream. The answer already names
  // the runs it canceled: the chat's records say so as it lands.
  describe("the chat's run records", () => {
    let records: ReturnType<typeof useRuntimeState>;
    function Records() { records = useRuntimeState(); return null; }
    const run = (id: string, status: RunRecord["status"] = "in_progress"): RunRecord => ({
      id, projectId: "space", sessionId: null, conversationId: "chat", promptId: null, runType: "prompt", status,
      progress: 0, progressStage: null, previewUrl: null, lastMessage: null, metadata: { jobId: id === "r1" ? "octo-1" : "scribe-1" },
      createdAt: "2026-11-07T21:38:08.686Z", updatedAt: "2026-11-07T21:38:39.000Z",
    });
    async function mount(next: Partial<ChatRunStopOptions> = {}) {
      props = { ...props, ...next };
      await act(async () => { root.render(<RuntimeStateProvider><Records /><Harness /></RuntimeStateProvider>); });
      await act(async () => { records.upsertRun(run("r1")); records.upsertRun(run("r2")); });
    }
    afterEach(() => clearReplyDrafts());

    it("say canceled, with no reply draft, for the runs the answer canceled, before their stream says so", async () => {
      await mount({ targets: [octo, scribe] });
      applyReplyDraft({ conversationId: "chat", jobId: "octo-1", runId: "r1", attempt: 1, segment: 0, seq: 1, text: "Added a one-line tip", startedAt: 1, updatedAt: 1 });
      cancel.mockResolvedValue({ ok: true, canceledJobIds: ["octo-1"], canceledRunIds: ["r1"], alreadyFinishedJobIds: ["scribe-1"] });
      await act(async () => controller!.requestStop());
      expect(records.runs.r1?.status).toBe("canceled");
      expect(conversationReplyDrafts("chat")).toEqual([]);
      // A run the answer calls finished keeps its own record.
      expect(records.runs.r2?.status).toBe("in_progress");
      // The run's own record, when it comes, keeps it canceled; a late progress
      // tick never brings it back.
      await act(async () => { records.upsertRun({ ...run("r1"), updatedAt: "2026-11-07T21:38:41.000Z" }); });
      expect(records.runs.r1?.status).toBe("canceled");
    });

    it.each([
      ["refused", () => cancel.mockResolvedValue({ ok: false, canceledJobIds: ["octo-1"], canceledRunIds: ["r1"], alreadyFinishedJobIds: [] })],
      ["failed", () => cancel.mockRejectedValue(new Error("Simulated connection failure."))],
      ["already finished", () => cancel.mockResolvedValue({ ok: true, canceledJobIds: [], canceledRunIds: [], alreadyFinishedJobIds: ["octo-1"] })],
    ])("never say canceled for a Stop the controller %s", async (_, answer) => {
      await mount(); answer();
      await act(async () => controller!.requestStop());
      expect(records.runs.r1?.status).toBe("in_progress");
    });

    it("never say canceled for a Stop that has not answered yet", async () => {
      cancel.mockReturnValue(new Promise(() => undefined)); await mount();
      await act(async () => controller!.requestStop());
      await act(async () => vi.advanceTimersByTimeAsync(CHAT_RUN_STOP_TIMEOUT_MS));
      expect(controller!.phase).toBe("error");
      expect(records.runs.r1?.status).toBe("in_progress");
    });
  });
});
