// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectHatchling } from "../../../../components/__tests__/octoCoinExpectations";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { MultiAgentPlanEntry, MultiAgentRunsContext } from "../MultiAgentPlanEntry";
import { ViewerAgentsContext } from "../viewerAgents";

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
  const openRun = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.resetAllMocks(); controller.fetchPlanGroupStatus.mockResolvedValue(null);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(runs: RunRecord[], messages: ChatMessage[] = [], planMessage = plan, scopeKey = "viewer-project-conversation", planDetails: Record<string, unknown> = details) {
    await act(async () => root.render(
      <MultiAgentRunsContext.Provider value={{ runs: Object.fromEntries(runs.map(value => [value.id, value])), scopeKey }}>
        <MultiAgentPlanEntry details={planDetails} planMessage={planMessage} conversationMessages={messages}
          conversationLocalId="local" onOpenWorkerRunTrace={openRun} />
      </MultiAgentRunsContext.Provider>,
    ));
  }
  const status = (handle: string) => container.querySelector(`[data-agent-handle="@${handle}"]`)?.getAttribute("aria-label");

  it("shows task labels while preserving worker identity and the exact run behind each chip", async () => {
    const completed = run("poet09", "success");
    completed.metadata = { ...completed.metadata, leaseMetrics: { leasedByRuntimeId: "runtime-nine", agentHandle: "poet09" } };
    await render([completed, run("poet10", "queued")], [], plan, undefined, {
      ...details, agents: [
        { handle: "poet09", label: "Refrain poem", title: "Ignored alias", scopeSummary: "poems/refrain.txt" },
        { handle: "poet10", title: "Moon poem" },
      ],
    });
    const refrain = container.querySelector<HTMLButtonElement>('[data-agent-handle="@poet09"]')!;
    const moon = container.querySelector<HTMLButtonElement>('[data-agent-handle="@poet10"]')!;
    expect(refrain.textContent).toBe("Refrain poem");
    expect(moon.textContent).toBe("Moon poem");
    expect(refrain.title).toContain("Refrain poem (@poet09)");
    expect(refrain.title).toContain("poems/refrain.txt");
    expect(status("poet09")).toBe("Open run trace for Refrain poem (@poet09); status done");
    expect(status("poet10")).toBe("Open run trace for Moon poem (@poet10); status queued");
    expect(container.querySelector('[data-testid="multi-agent-team-chip"]')?.getAttribute("title")).toContain("Refrain poem · runtime runtime-");
    await act(async () => { refrain.click(); moon.click(); });
    expect(openRun.mock.calls).toEqual([
      [{ jobId: "parent-job-poet09-job", title: "Refrain poem run" }],
      [{ jobId: "parent-job-poet10-job", title: "Moon poem run" }],
    ]);
  });

  it("keeps same-named tasks separate and falls back to handles for older plans", async () => {
    await render([run("poet09", "success"), run("poet10", "queued")], [], plan, undefined, {
      ...details, agents: [{ handle: "poet09", label: "Review" }, { handle: "poet10", label: "Review" }],
    });
    expect(status("poet09")).toContain("Review (@poet09); status done");
    expect(status("poet10")).toContain("Review (@poet10); status queued");
    await render([run("poet09", "success"), run("poet10", "queued")]);
    expect(container.querySelector('[data-agent-handle="@poet09"]')?.textContent).toBe("@poet09");
    expect(status("poet10")).toBe("Open run trace for @poet10; status queued");
  });

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

  it.each(["pending", "answered"])("keeps a %s question waiting for input after the provider turn succeeds", async (statusValue) => {
    const waiting = run("poet10", "success");
    waiting.metadata = { ...waiting.metadata, userInputRequest: { requestId: "request-ten", status: statusValue } };
    await render([run("poet09", "success"), waiting]);
    expect(status("poet10")).toContain("status waiting for input");
    expect(container.querySelector('[data-testid="multi-agent-inline-status"]')?.getAttribute("aria-label")).toContain("1 waiting for input");
    expect(container.querySelector('[data-testid="multi-agent-cancel-group"]')).not.toBeNull();
  });

  it("keeps cancellation and failure authoritative and does not call an expired assignment done", async () => {
    const waiting = run("poet10", "canceled");
    waiting.metadata = { ...waiting.metadata, userInputRequest: { requestId: "request-ten", status: "pending" } };
    await render([run("poet09", "success"), waiting]);
    expect(status("poet10")).toContain("status canceled");
    await render([run("poet09", "success"), { ...waiting, status: "failed" }]);
    expect(status("poet10")).toContain("status failed");
    for (const requestStatus of ["resumed", "expired"]) {
      await render([run("poet09", "success"), { ...waiting, status: "success", metadata: {
        ...waiting.metadata, userInputRequest: { requestId: "request-ten", status: requestStatus },
      } }]);
      expect(status("poet10")).toContain(requestStatus === "expired" ? "status failed" : "status done");
    }
  });

  it("hydrates a worker waiting for human input without labelling it an approval", async () => {
    controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "old-group", workers: [
      { jobId: "job-nine", handle: "poet09", status: "completed" },
      { jobId: "job-ten", handle: "poet10", status: "awaiting_input" },
    ] });
    await render([], [], { ...plan, metadata: { ...plan.metadata, multiAgentPlan: { groupId: "old-group" } } });
    expect(status("poet10")).toContain("status waiting for input");
    expect(container.textContent).not.toContain("approval");
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

  describe("a lane the controller ran again", () => {
    const stopped = () => {
      const value = run("poet10", "failed");
      value.createdAt = "2026-10-15T08:00:00Z";
      return value;
    };
    const continuation = (status: RunRecord["status"], key: "continuation" | "rateLimitRetry" | "userInputContinuation" = "continuation") => {
      const value = run("poet10", status);
      value.id = "poet10-next-run";
      value.createdAt = "2026-10-15T08:10:00Z";
      value.metadata = { ...value.metadata, jobId: "poet10-next-job",
        multiAgentPlan: { parentJobId: "parent-job", groupId: "parent-job-group", role: "worker", [key]: { of: "parent-job-poet10-job" } } };
      return value;
    };
    const message = (id: string, jobId: string, timestamp: number, extra: Record<string, unknown>, content = ""): ChatMessage => ({
      id, role: "assistant", timestamp, content,
      metadata: { jobId, agent: { handle: "poet10" }, ...extra,
        multiAgentPlan: { parentJobId: "parent-job", groupId: "parent-job-group", role: "worker", ...(extra.multiAgentPlan as object) } },
    });
    const notice = () => container.querySelector('[data-testid="plan-rerun-notice"]');

    it("shows a continued lane as its continuation with one quiet line, even when only the stopped run is in the feed", async () => {
      const opened: Array<{ jobId: string; title: string }> = [];
      const working = message("next-update", "poet10-next-job", 9, { kind: "update", multiAgentPlan: { continuation: { of: "parent-job-poet10-job" } } });
      await act(async () => root.render(
        <MultiAgentRunsContext.Provider value={{ runs: { a: run("poet09", "success"), b: stopped() }, scopeKey: "viewer" }}>
          <MultiAgentPlanEntry details={details} planMessage={plan} conversationMessages={[working]}
            conversationLocalId="local" onOpenWorkerRunTrace={(value) => opened.push(value)} />
        </MultiAgentRunsContext.Provider>,
      ));
      expect(status("poet10")).toBe("Open run trace for @poet10; status active");
      expect(container.querySelector('[data-testid="multi-agent-inline-status"]')?.getAttribute("aria-label")).not.toContain("need attention");
      expect(container.querySelectorAll('[data-testid="plan-rerun-notice"]')).toHaveLength(1);
      expect(notice()?.textContent).toBe("@poet10 ran out of turn time and continued in a new turn.Open continuation");
      await act(async () => (container.querySelector('[data-testid="plan-rerun-open"]') as HTMLButtonElement).click());
      expect(opened).toEqual([{ jobId: "poet10-next-job", title: "@poet10 run" }]);
      (container.querySelector('[data-agent-handle="@poet10"]') as HTMLButtonElement).click();
      expect(opened[1]).toEqual({ jobId: "poet10-next-job", title: "@poet10 run" });
    });

    it("reads the continuation's own run over the stopped one whatever order the feed holds them in", async () => {
      await render([continuation("success"), run("poet09", "success"), stopped()]);
      expect(status("poet10")).toContain("status done");
      expect(container.querySelector('[data-testid="multi-agent-inline-status"]')?.getAttribute("aria-label")).toContain("2/2 lanes done");
      expect(notice()?.getAttribute("data-rerun-reason")).toBe("turn_continuation");
    });

    it("follows the resumed worker lane instead of keeping its earlier question waiting", async () => {
      const paused = run("poet10", "success");
      paused.metadata = { ...paused.metadata, userInputRequest: { requestId: "request-ten", status: "answered" } };
      await render([continuation("in_progress", "userInputContinuation"), run("poet09", "success"), paused]);
      expect(status("poet10")).toContain("status active");
      expect(notice()?.textContent).toContain("@poet10 continued after an answer.");
      expect(notice()?.getAttribute("data-rerun-reason")).toBe("user_input");
    });

    it("does not let the stopped run's error decide a lane whose continuation has not posted yet", async () => {
      const failure = message("stop", "parent-job-poet10-job", 5, { messageType: "error", outcome: "failed" }, "Codex run timed out");
      const queued = message("queued", "poet10-next-job", 6, { kind: "update", multiAgentPlan: { continuation: { of: "parent-job-poet10-job" } } });
      await render([run("poet09", "success")], [failure, queued]);
      expect(status("poet10")).toContain("status active");
      expect(container.textContent).not.toContain("need attention");
    });

    it("shows a rate-limit retry from the group status the same way", async () => {
      const historicalPlan = { ...plan, metadata: { ...plan.metadata, multiAgentPlan: { groupId: "old-group" } } };
      controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "old-group", workers: [
        { jobId: "job-nine", handle: "poet09", status: "completed" },
        { jobId: "job-ten", handle: "poet10", status: "failed", retriedAs: "job-ten-again", retriedFor: "rate_limit" },
        { jobId: "job-ten-again", handle: "poet10", status: "leased" },
      ] });
      await render([], [], historicalPlan);
      expect(status("poet10")).toContain("status active");
      expect(notice()?.textContent).toContain("@poet10 stopped on a short rate limit and ran again.");
    });

    it("keeps a lane that failed without a rerun red and says nothing about continuing", async () => {
      await render([run("poet09", "success"), stopped()]);
      expect(status("poet10")).toContain("status failed");
      expect(notice()).toBeNull();
    });
  });

  describe("the legend", () => {
    const face = (handle: string) =>
      container.querySelector(`[data-agent-handle="@${handle}"] > [data-testid="multi-agent-chip-face"]`);
    const stampedRun = (handle: string, status: RunRecord["status"], avatarSeed: string) => {
      const value = run(handle, status);
      value.metadata = { ...value.metadata, agent: { handle, avatarSeed } };
      return value;
    };
    const update = (handle: string, jobId: string, avatarSeed: string): ChatMessage => ({
      id: `${jobId}-update`, role: "assistant", content: "", timestamp: 2, metadata: {
        jobId, kind: "update", agent: { handle, avatarSeed },
        multiAgentPlan: { parentJobId: "parent-job", groupId: "parent-job-group", role: "worker" } },
    });

    it("puts each lane's face before its label: the face its run is stamped with, else its handle's", async () => {
      await render([stampedRun("poet09", "success", "hatchling:3"), run("poet10", "queued")], [], plan, undefined, {
        ...details, agents: [{ handle: "poet09", label: "Refrain poem" }, { handle: "poet10", label: "Moon poem" }],
      });
      expect(expectHatchling(face("poet09"))).toBe("3");
      // A lane from before stamps wears the face its rows do: its handle's (poet10 is 1).
      expect(expectHatchling(face("poet10"))).toBe("1");
      // The chip's label names the lane, so the face beside it is decorative.
      expect(face("poet09")?.getAttribute("aria-hidden")).toBe("true");
      expect(face("poet09")?.nextElementSibling?.textContent).toBe("Refrain poem");
      expect(container.querySelector('[data-agent-handle="@poet09"]')?.textContent).toBe("Refrain poem");
      // Only lanes carry the legend; the lead's chip is its status alone.
      expect(container.querySelectorAll('[data-testid="multi-agent-chip-face"]')).toHaveLength(2);
    });

    it("takes a lane's face from the plan-group status before any loaded stamp", async () => {
      // poet10 has no run in the feed, so the card reads the group's status.
      controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "parent-job-group", workers: [
        { jobId: "parent-job-poet09-job", handle: "poet09", status: "completed", avatarSeed: "hatchling:6" },
        { jobId: "job-ten", handle: "poet10", status: "leased", avatarSeed: "hatchling:2" },
      ] });
      await render([stampedRun("poet09", "success", "hatchling:4")], [update("poet10", "job-ten", "hatchling:5")]);
      expect(controller.fetchPlanGroupStatus).toHaveBeenCalledWith("parent-job-group", expect.any(AbortSignal));
      expect(expectHatchling(face("poet09"))).toBe("6");
      expect(expectHatchling(face("poet10"))).toBe("2");
    });

    it("draws a lane that ran as the viewer's own saved agent from its current profile, its id kept under a status seed", async () => {
      // poet09 ran as the viewer's bot, stamped with its id and the face it
      // wore then; its owner has picked another face since. poet10 has no run
      // in the feed, so the card reads the group's status, whose seed for
      // poet09 is the one the run carries.
      const own = run("poet09", "success");
      own.metadata = { ...own.metadata, agent: { handle: "poet09", id: "own-bot", avatarSeed: "hatchling:4" } };
      controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "parent-job-group", workers: [
        { jobId: "parent-job-poet09-job", handle: "poet09", status: "completed", avatarSeed: "hatchling:4" },
        { jobId: "job-ten", handle: "poet10", status: "leased", avatarSeed: "hatchling:2" },
      ] });
      await act(async () => root.render(
        <ViewerAgentsContext.Provider value={new Map([["own-bot", { avatarSeed: "hatchling:7", handle: "poet09" }]])}>
          <MultiAgentRunsContext.Provider value={{ runs: { [own.id]: own }, scopeKey: "viewer-project-conversation" }}>
            <MultiAgentPlanEntry details={details} planMessage={plan} conversationMessages={[]}
              conversationLocalId="local" onOpenWorkerRunTrace={openRun} />
          </MultiAgentRunsContext.Provider>
        </ViewerAgentsContext.Provider>,
      ));
      expect(controller.fetchPlanGroupStatus).toHaveBeenCalled();
      expect(expectHatchling(face("poet09"))).toBe("7");
      // A helper is no one's saved agent: its status seed.
      expect(expectHatchling(face("poet10"))).toBe("2");
    });

    it("keeps the loaded stamps when the status comes from a controller from before faces", async () => {
      controller.fetchPlanGroupStatus.mockResolvedValue({ groupId: "parent-job-group", workers: [
        { jobId: "parent-job-poet09-job", handle: "poet09", status: "completed" },
        { jobId: "job-ten", handle: "poet10", status: "leased", avatarSeed: null },
      ] });
      await render([stampedRun("poet09", "success", "hatchling:4")], [update("poet10", "job-ten", "hatchling:5")]);
      expect(controller.fetchPlanGroupStatus).toHaveBeenCalled();
      expect(expectHatchling(face("poet09"))).toBe("4");
      expect(expectHatchling(face("poet10"))).toBe("5");
    });
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
