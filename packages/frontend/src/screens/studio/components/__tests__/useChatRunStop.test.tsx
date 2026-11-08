// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerConversationStopResult } from "../../../../services/runtimeController/conversationStop";

vi.mock("../../../../services/runtimeController/conversationStop", () => ({ stopConversationJobs: vi.fn() }));
import { applyReplyDraft, clearReplyDrafts, conversationReplyDrafts } from "../../../../conversations/replyDrafts";
import { RuntimeStateProvider, useRuntimeState } from "../../../../runtime/RuntimeStateProvider";
import type { RunRecord } from "../../../../types";
import { CHAT_RUN_STOP_TIMEOUT_MS, useChatRunStop, type ChatRunStopController, type ChatRunStopOptions, type ChatRunStopTarget } from "../useChatRunStop";

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

  it("offers Stop before any command and only with write capability in the active chat", async () => {
    await render(); expect(controller!.visible).toBe(true);
    await render({ canStop: false }); expect(controller!.visible).toBe(false);
    await act(async () => controller!.requestStop()); expect(cancel).not.toHaveBeenCalled();
    await render({ canStop: true, active: false }); expect(controller!.visible).toBe(false);
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
