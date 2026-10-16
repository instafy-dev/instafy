// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { MultiAgentPlanEntry, MultiAgentRunsContext } from "../MultiAgentPlanEntry";

const controller = vi.hoisted(() => ({ fetchPlanGroupStatus: vi.fn(), cancelPlanGroup: vi.fn() }));
vi.mock("../../../../services/runtimeController/jobs", () => controller);

const details = { agents: [{ handle: "poet09" }, { handle: "poet10" }], lead: { leadHandle: "octo" } };
const plan: ChatMessage = { id: "plan", role: "assistant", content: "Write poems", timestamp: 1,
  metadata: { jobId: "parent-job", messageType: "multi_agent_plan" } };
function run(handle: string, status: RunRecord["status"], role = "worker", parentJobId = "parent-job"): RunRecord {
  return {
    id: `${parentJobId}-${handle}-run`, projectId: "project", sessionId: null, conversationId: "conversation", promptId: null,
    runType: "prompt", status, progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: "2026-10-15T08:00:00Z", updatedAt: "2026-10-15T08:01:00Z",
    metadata: { jobId: `${parentJobId}-${handle}-job`, agent: { handle },
      multiAgentPlan: { parentJobId, groupId: `${parentJobId}-group`, role } },
  };
}

describe("multi-agent lifecycle from persisted runs", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.resetAllMocks(); controller.fetchPlanGroupStatus.mockResolvedValue(null);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(runs: RunRecord[], messages: ChatMessage[] = [], planMessage = plan, scopeKey = "viewer-project-conversation") {
    await act(async () => root.render(
      <MultiAgentRunsContext.Provider value={{ runs: Object.fromEntries(runs.map(value => [value.id, value])), scopeKey }}>
        <MultiAgentPlanEntry details={details} planMessage={planMessage} conversationMessages={messages}
          conversationLocalId="local" onOpenWorkerRunTrace={() => undefined} />
      </MultiAgentRunsContext.Provider>,
    ));
  }
  const status = (handle: string) => container.querySelector(`[data-agent-handle="@${handle}"]`)?.getAttribute("aria-label");

  it("hydrates a never-leased canceled worker and hides cancellation after the lead ends", async () => {
    const persisted = [run("poet09", "success"), run("poet10", "canceled"), run("octo", "success", "lead_continuation")];
    await render(persisted);
    expect(status("poet09")).toContain("status done");
    expect(status("poet10")).toContain("status canceled");
    expect(container.textContent).toContain("canceled");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-inline-status"]')?.getAttribute("aria-label")).toContain("1 canceled");
    // A fresh mount has no remembered cancel response or worker messages.
    await act(async () => root.unmount()); root = createRoot(container);
    await render(persisted);
    expect(status("poet10")).toContain("status canceled");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).toBeNull();
  });

  it("updates a queued worker from the run feed without requiring a worker message", async () => {
    await render([run("poet09", "success"), run("poet10", "queued")]);
    expect(status("poet10")).toBe("Open run trace for @poet10; status queued");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).not.toBeNull();
    await render([run("poet09", "success"), run("poet10", "canceled")]);
    expect(status("poet10")).toContain("status canceled");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).toBeNull();
  });

  it("does not confuse same-handle runs from another plan and keeps approval waits visible", async () => {
    await render([run("poet09", "in_progress"), run("poet10", "awaiting_approval"), run("poet10", "success", "worker", "other-plan")]);
    expect(status("poet09")).toContain("status active");
    expect(status("poet10")).toContain("status waiting for approval");
    expect(container.querySelector('[data-testid="multi-agent-inline-status"]')?.getAttribute("aria-label")).toContain("1 waiting for approval");
  });

  it("uses a persisted group identity when a parent has more than one dispatched plan", async () => {
    const currentPlan = { ...plan, metadata: { ...plan.metadata, multiAgentPlan: { groupId: "parent-job-group" } } };
    const otherGroup = run("poet10", "success");
    otherGroup.id = "another-group-run";
    otherGroup.metadata = { ...otherGroup.metadata, multiAgentPlan: { role: "worker", parentJobId: "parent-job", groupId: "another-group" } };
    await render([run("poet09", "in_progress"), run("poet10", "queued"), otherGroup], [], currentPlan);
    expect(status("poet10")).toContain("status queued");
    expect(controller.fetchPlanGroupStatus).not.toHaveBeenCalled();
  });

  it("uses messages as evidence without letting a warning override a persisted successful outcome", async () => {
    const worker = run("poet09", "success");
    await render([worker, run("poet10", "queued")], [{ id: "warning", role: "assistant", timestamp: 5,
      content: "Workspace updated, but auto-save failed", messageType: "error",
      metadata: { ...worker.metadata, messageType: "error", outcome: "failed" } }]);
    expect(status("poet09")).toContain("status done");
    expect(status("poet10")).toContain("status queued");
  });

  it("loads an old group's durable worker state once when its runs are outside recent history", async () => {
    const historicalPlan = { ...plan, metadata: { ...plan.metadata, multiAgentPlan: { groupId: "old-group" } } };
    controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "old-group", workers: [
      { jobId: "job-nine", handle: "poet09", status: "completed" },
      { jobId: "job-ten", handle: "poet10", status: "canceled" },
    ] });
    await render([], [], historicalPlan);
    expect(status("poet09")).toContain("status done");
    expect(status("poet10")).toContain("status canceled");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).toBeNull();
    await render([], [], historicalPlan);
    expect(controller.fetchPlanGroupStatus).toHaveBeenCalledTimes(1);
    expect(controller.fetchPlanGroupStatus).toHaveBeenCalledWith("old-group", expect.any(AbortSignal));
  });

  it("recovers legacy group identity from the final lead without any worker messages", async () => {
    controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "legacy-group", workers: [
      { jobId: "job-nine", handle: "poet09", status: "canceled" },
      { jobId: "job-ten", handle: "poet10", status: "canceled" },
    ] });
    await render([], [{ id: "lead", role: "assistant", content: "Canceled", timestamp: 3,
      metadata: { multiAgentPlan: { role: "lead_continuation", parentJobId: "parent-job", groupId: "legacy-group" }, outcome: "succeeded" } }]);
    expect(status("poet10")).toContain("status canceled");
    expect(controller.fetchPlanGroupStatus).toHaveBeenCalledWith("legacy-group", expect.any(AbortSignal));
  });

  it("settles historical queued workers from a successful cancellation without another lookup", async () => {
    const historicalPlan = { ...plan, metadata: { ...plan.metadata, multiAgentPlan: { groupId: "old-group" } } };
    controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "old-group", workers: [
      { jobId: "job-nine", handle: "poet09", status: "completed" },
      { jobId: "job-ten", handle: "poet10", status: "queued" },
    ] });
    controller.cancelPlanGroup.mockResolvedValue({ ok: true, canceledJobIds: ["job-ten"] });
    await render([], [], historicalPlan);
    await act(async () => {
      (container.querySelector('[data-testid="multi-agent-cancel-group"]') as HTMLButtonElement).click();
    });
    expect(controller.cancelPlanGroup).toHaveBeenCalledExactlyOnceWith("old-group");
    expect(status("poet09")).toContain("status done");
    expect(status("poet10")).toContain("status canceled");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).toBeNull();
    expect(controller.fetchPlanGroupStatus).toHaveBeenCalledTimes(1);
  });

  it("discards a historical lookup when the viewer changes before it finishes", async () => {
    let finish!: (value: unknown) => void;
    controller.fetchPlanGroupStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const historicalPlan = { ...plan, metadata: { ...plan.metadata, multiAgentPlan: { groupId: "old-group" } } };
    await render([], [], historicalPlan);
    await render([], [], historicalPlan, "different-viewer");
    await act(async () => finish({ groupId: "old-group", workers: [{ jobId: "old-job", handle: "poet10", status: "canceled" }] }));
    expect(status("poet10")).toContain("status queued");
  });

  it("shows a refused plan's reason without inventing queued workers or offering cancellation", async () => {
    await render([], [], { ...plan, metadata: { ...plan.metadata, multiAgentPlan: {
      groupId: "refused-group", status: "refused", refusalReason: "This project allows at most 8 agents per plan; 10 were requested.",
    } } });
    expect(container.querySelector('[data-testid="multi-agent-plan-refused"]')?.textContent).toContain("Workstreams did not start");
    expect(container.textContent).toContain("10 were requested");
    expect(container.querySelector('[data-testid="multi-agent-evidence-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).toBeNull();
    expect(controller.fetchPlanGroupStatus).not.toHaveBeenCalled();
  });
});
