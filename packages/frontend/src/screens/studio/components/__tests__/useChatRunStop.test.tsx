// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerConversationStopResult } from "../../../../services/runtimeController/conversationStop";

vi.mock("../../../../services/runtimeController/conversationStop", () => ({ stopConversationJobs: vi.fn() }));
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
});
