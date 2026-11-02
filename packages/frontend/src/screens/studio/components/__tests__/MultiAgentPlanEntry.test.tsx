// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classTokens, expectCanonicalOctoCoin, expectHatchling } from "../../../../components/__tests__/octoCoinExpectations";
import type { RunRecord } from "../../../../types";
import type { SavedAgentFace } from "../../../../utils/aiFace";
import type { ChatMessage } from "../../types";
import { ChatMessageAvatar } from "../ChatMessageAvatar";
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
    // The word is gone from the chip; its glyph and the aria-label carry it.
    expect(container.querySelector('[data-agent-handle="@poet10"] [data-chip-status="canceled"]')).not.toBeNull();
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
      // Lanes carry the legend; the lead wears its own face under its own id.
      expect(container.querySelectorAll('[data-testid="multi-agent-chip-face"]')).toHaveLength(2);
      expectCanonicalOctoCoin(container.querySelector('[data-testid="multi-agent-lead-status"] > [data-testid="multi-agent-lead-face"]'));
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

  describe("the chips", () => {
    const chip = (handle: string) => container.querySelector<HTMLButtonElement>(`[data-agent-handle="@${handle}"]`)!;
    const leadFace = () => container.querySelector('[data-testid="multi-agent-lead-status"] > [data-testid="multi-agent-lead-face"]');

    it("puts the lead's own face, Octo's tile, in a group whose name carries its status", async () => {
      await render([run("poet09", "success"), run("poet10", "in_progress"), run("octo", "in_progress", "lead_continuation")]);
      const lead = container.querySelector('[data-testid="multi-agent-lead-status"]');
      expect(lead?.getAttribute("role")).toBe("group");
      expect(lead?.getAttribute("aria-label")).toBe("Lead @octo; status active");
      // Face, name, status, as on a lane.
      expectCanonicalOctoCoin(lead?.firstElementChild);
      expect(lead?.firstElementChild?.getAttribute("data-testid")).toBe("multi-agent-lead-face");
      expect(lead?.textContent).toBe("@octo");
      expect(lead?.lastElementChild?.getAttribute("data-chip-status")).toBe("working");
    });

    it("puts a lead other than Octo in the face stamped on its own rows, not its handle's", async () => {
      const benLeads = { ...details, lead: { leadHandle: "ben" } };
      // Ben planned from his own turn wearing face 1; his handle alone is face 3.
      const benPlan = { ...plan, metadata: { ...plan.metadata, agent: { handle: "ben", avatarSeed: "hatchling:1" } } };
      await render([run("poet09", "success"), run("poet10", "in_progress")], [], benPlan, undefined, benLeads);
      expect(container.querySelector('[data-testid="multi-agent-lead-status"]')?.textContent).toBe("@ben");
      expect(expectHatchling(leadFace())).toBe("1");
      // Octo wrote this plan, so its stamp is not Ben's: his continuation's is.
      const octoPlan = { ...plan, metadata: { ...plan.metadata, agent: { handle: "octo", avatarSeed: "octo" } } };
      const continuation = run("ben", "in_progress", "lead_continuation");
      continuation.metadata = { ...continuation.metadata, agent: { handle: "ben", avatarSeed: "hatchling:1" } };
      await render([run("poet09", "success"), run("poet10", "success"), continuation], [], octoPlan, undefined, benLeads);
      expect(expectHatchling(leadFace())).toBe("1");
      // With none of his stamps loaded, his handle's face, as his rows from before stamps wear.
      await render([run("poet09", "success"), run("poet10", "in_progress")], [], octoPlan, undefined, benLeads);
      expect(expectHatchling(leadFace())).toBe("3");
    });

    it("draws a lead that is the viewer's own saved agent from its current profile, picture and all, as its rows do", async () => {
      // Pia's reply is stamped with her id and the face she wore then (her
      // handle alone is face 2); her owner has given her a picture since.
      const picture = "https://images.example/pia.png";
      const reply: ChatMessage = { id: "lead-reply", role: "assistant", content: "Both poems are in.", timestamp: 3, metadata: {
        jobId: "lead-job", outcome: "succeeded", agent: { handle: "pia", id: "own-pia", avatarSeed: "hatchling:5" },
        multiAgentPlan: { role: "lead_continuation", parentJobId: "parent-job", groupId: "parent-job-group" } } };
      const renderFor = (viewerAgents: ReadonlyMap<string, SavedAgentFace>) => act(async () => root.render(
        <ViewerAgentsContext.Provider value={viewerAgents}>
          <MultiAgentRunsContext.Provider value={{ runs: { nine: run("poet09", "success"), ten: run("poet10", "success") }, scopeKey: "viewer" }}>
            <MultiAgentPlanEntry details={{ ...details, lead: { leadHandle: "pia" } }} planMessage={plan} conversationMessages={[reply]} />
          </MultiAgentRunsContext.Provider>
          {/* The reply's own face, from the same row. */}
          <ChatMessageAvatar kind="assistant" metadata={reply.metadata} />
        </ViewerAgentsContext.Provider>,
      ));
      const rowFace = () => container.querySelector('[data-testid="chat-avatar-assistant"]');
      // To a viewer she does not belong to, she wears her stamp.
      await renderFor(new Map());
      expect(expectHatchling(leadFace())).toBe("5");
      expect(expectHatchling(rowFace())).toBe("5");
      await renderFor(new Map([["own-pia", { avatarSeed: picture, handle: "pia" }]]));
      expect(leadFace()?.querySelector(":scope > img")?.getAttribute("src")).toBe(picture);
      expect(rowFace()?.querySelector(":scope > img")?.getAttribute("src")).toBe(picture);
    });

    it("leads a lane's tooltip with its status, since the \"…\" covers the glyph under the pointer", async () => {
      await render([run("poet09", "failed"), run("poet10", "queued")], [], plan, undefined, {
        ...details, agents: [{ handle: "poet09", label: "Refrain poem", scopeSummary: "poems/refrain.txt" }, { handle: "poet10" }],
      });
      expect(chip("poet09").title).toMatch(/^Refrain poem \(@poet09\) · failed\n/);
      expect(chip("poet09").title.split("\n")).toEqual(["Refrain poem (@poet09) · failed", "poems/refrain.txt"]);
      expect(chip("poet10").title).toBe("@poet10 · queued");
    });

    it("draws one grey chip per lane with one status glyph after its name, a different shape for each status", async () => {
      const statuses = {
        poet01: ["queued", "queued"], poet02: ["in_progress", "working"], poet03: ["success", "done"],
        poet04: ["failed", "failed"], poet05: ["canceled", "canceled"], poet06: ["awaiting_approval", "waiting"],
        poet07: ["success", "waiting_input"],
      } as const;
      const runs = Object.entries(statuses).map(([handle, [runStatus]]) => run(handle, runStatus));
      const asking = runs[runs.length - 1];
      asking.metadata = { ...asking.metadata, userInputRequest: { requestId: "request-seven", status: "pending" } };
      await render(runs, [], plan, undefined, { ...details, agents: Object.keys(statuses).map((handle) => ({ handle })) });
      const glyphs = new Set<string>();
      for (const [handle, [, status]] of Object.entries(statuses)) {
        const lane = chip(handle);
        const slots = lane.querySelectorAll("[data-chip-status]");
        expect(slots, handle).toHaveLength(1);
        const slot = slots[0];
        expect(slot.getAttribute("data-chip-status")).toBe(status);
        // Face first, then the name, then the status: never a mark beside the face.
        expect(lane.firstElementChild?.getAttribute("data-testid")).toBe("multi-agent-chip-face");
        expect(slot.previousElementSibling?.textContent).toBe(`@${handle}`);
        expect(lane.lastElementChild).toBe(slot);
        expect(slot.textContent).toBe("");
        glyphs.add(slot.innerHTML);
        // Colour only where the person must act (amber) or something failed
        // (rose), and those glyphs are drawn heavier: failed is the one solid
        // glyph (a fill, no stroke), so weight tells it from amber without hue.
        const tone = classTokens(slot).find((token) => /^text-(slate|rose|amber)-/.test(token));
        expect(tone, handle).toBe(status === "failed" ? "text-rose-700"
          : status === "waiting" || status === "waiting_input" ? "text-amber-700" : "text-slate-600");
        expect(slot.querySelector("svg")?.getAttribute("stroke-width") ?? null, handle).toBe(
          status === "failed" || status === "working" ? null : tone === "text-slate-600" ? "1.5" : "2");
        expect(slot.querySelectorAll('svg path[fill="currentColor"]').length > 0, handle).toBe(status === "failed");
        // The chip itself is one grey for every status, with no ring or border.
        const chipTokens = classTokens(lane);
        expect(chipTokens.filter((token) => /(sky|emerald|rose|amber)-/.test(token)), handle).toEqual([]);
        expect(chipTokens.filter((token) => /^(dark:)?(ring|border)(-|$)/.test(token)), handle).toEqual([]);
        expect(chipTokens).toContain(status === "done" || status === "canceled" ? "bg-slate-50" : "bg-slate-100");
      }
      expect(glyphs.size).toBe(Object.keys(statuses).length);
    });

    it("keeps Workstreams' and Cancel group's touch targets inside the gaps the row opens on touch", async () => {
      // Their 44px targets reach 10px above and below their 24px boxes; the
      // row's touch gaps are 12px, so nothing visible is ever under them
      // (docs/Brand.md, "A plan's helper chips").
      const leased = run("poet09", "success");
      leased.metadata = { ...leased.metadata, leaseMetrics: { leasedByRuntimeId: "runtime-nine", agentHandle: "poet09" } };
      await render([leased, run("poet10", "queued")]);
      expect(classTokens(container.querySelector('[data-testid="multi-agent-inline-status"]'))).toEqual(
        expect.arrayContaining(["pointer-coarse:mt-3", "pointer-coarse:gap-y-3"]),
      );
      const team = container.querySelector('[data-testid="multi-agent-team-chip"]');
      const cancel = container.querySelector('[data-testid="multi-agent-cancel-group"]');
      expect(team?.tagName).toBe("BUTTON");
      expect(cancel?.tagName).toBe("BUTTON");
      for (const control of [team, cancel]) {
        const tokens = classTokens(control);
        expect(tokens).toEqual(expect.arrayContaining(["relative", "pointer-coarse:!min-h-0", "pointer-coarse:after:-inset-y-2.5"]));
        // A negative margin would hang the box itself into the gaps.
        expect(tokens.filter((token) => /(^|:)!?-m[ytb]-/.test(token))).toEqual([]);
      }
    });

    it("rings a details panel's Full note as the chips are ringed", async () => {
      const long = run("poet09", "success");
      long.lastMessage = "Wrote the refrain and checked its meter against the brief. ".repeat(12);
      await render([long, run("poet10", "queued")], [], plan, undefined, {
        ...details, presentation: { workerEvidenceVisibility: "expanded" },
      });
      const fullNote = container.querySelector('[data-testid="multi-agent-evidence-full-toggle"]');
      expect(fullNote?.textContent).toBe("Full note");
      // primary-500 (4.51:1 on white), not primary-400 (2.29:1), and a real
      // outline in forced colours, which drop the ring.
      expect(classTokens(fullNote)).toEqual(expect.arrayContaining(["focus-visible:ring-primary-500", "focus:outline-hidden"]));
      expect(classTokens(fullNote)).not.toContain("focus-visible:ring-primary-400");
      expect(classTokens(fullNote)).not.toContain("focus:outline-none");
    });
  });

  describe("a long-press on a lane", () => {
    // Stands in for ChatMessageEntries' bubble, whose own touch long-press
    // and context menu open the message's actions.
    const bubblePointerDown = vi.fn();
    const bubbleContextMenu = vi.fn();
    const chip = (handle: string) => container.querySelector<HTMLButtonElement>(`[data-agent-handle="@${handle}"]`)!;
    const menu = () => document.body.querySelector('[data-testid="multi-agent-chip-menu"]');
    const pointer = (target: Element, type: string, pointerType: string, init: MouseEventInit = {}, pointerId = 1) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 10, ...init });
      Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: pointerId } });
      return target.dispatchEvent(event);
    };
    const contextMenu = (target: Element) =>
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const escape = () => act(async () => {
      menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
    const frames = () => act(async () => {
      for (let frame = 0; frame < 2; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    async function renderInBubble(agents = details.agents) {
      await act(async () => root.render(
        <div onPointerDown={bubblePointerDown} onContextMenu={bubbleContextMenu}>
          <MultiAgentRunsContext.Provider value={{ runs: { nine: run("poet09", "in_progress"), ten: run("poet10", "queued") }, scopeKey: "viewer" }}>
            <MultiAgentPlanEntry details={{ ...details, agents }} planMessage={plan} conversationMessages={[]}
              conversationLocalId="local" onOpenWorkerRunTrace={openRun} />
          </MultiAgentRunsContext.Provider>
        </div>,
      ));
    }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // jsdom has no CSS.escape, which a menu opened from its "…" uses to focus its first item.
      vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("opens that lane's menu after 420ms, stops the bubble's own, and swallows the click that ends it", async () => {
      await renderInBubble();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "touch"); });
      expect(bubblePointerDown).not.toHaveBeenCalled();
      await wait(419);
      expect(menu()).toBeNull();
      await wait(1);
      expect(menu()).not.toBeNull();
      const menuButton = chip("poet09").parentElement?.querySelector('[data-testid="multi-agent-chip-menu-button"]');
      expect(menuButton?.getAttribute("aria-expanded")).toBe("true");
      // Android's long-press contextmenu does not open the message's menu.
      expect(contextMenu(chip("poet09"))).toBe(false);
      expect(bubbleContextMenu).not.toHaveBeenCalled();
      await act(async () => {
        pointer(chip("poet09"), "pointerup", "touch");
        chip("poet09").click();
      });
      expect(openRun).not.toHaveBeenCalled();
      expect(menu()).not.toBeNull();
    });

    it("lets a touch that moves more than 8px, and any mouse press, through as a press", async () => {
      await renderInBubble();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "touch", { clientX: 40, clientY: 10 }); });
      await wait(200);
      await act(async () => { pointer(chip("poet09"), "pointermove", "touch", { clientX: 40, clientY: 19 }); });
      await wait(400);
      expect(menu()).toBeNull();
      await act(async () => {
        pointer(chip("poet09"), "pointerup", "touch", { clientX: 40, clientY: 19 });
        chip("poet09").click();
      });
      expect(openRun).toHaveBeenCalledExactlyOnceWith({ jobId: "parent-job-poet09-job", title: "@poet09 run" });

      await act(async () => { pointer(chip("poet10"), "pointerdown", "mouse"); });
      await wait(1000);
      expect(menu()).toBeNull();
      // A mouse press reaches the bubble as before.
      expect(bubblePointerDown).toHaveBeenCalledTimes(1);
      await act(async () => {
        pointer(chip("poet10"), "pointerup", "mouse");
        chip("poet10").click();
      });
      expect(openRun).toHaveBeenLastCalledWith({ jobId: "parent-job-poet10-job", title: "@poet10 run" });
    });

    it("never swallows the next mouse, keyboard, screen-reader or right-click press when the click that ends it never comes", async () => {
      // The menu takes focus, or Android sends no click: the latch must not
      // wait for one.
      await renderInBubble();
      const longPressWithoutClick = async () => {
        await act(async () => { pointer(chip("poet09"), "pointerdown", "touch"); });
        await wait(420);
        await act(async () => { pointer(chip("poet09"), "pointerup", "touch"); });
        expect(menu()).not.toBeNull();
        await act(async () => {
          menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        });
        expect(menu()).toBeNull();
      };

      await longPressWithoutClick();
      await act(async () => {
        pointer(chip("poet10"), "pointerdown", "mouse");
        pointer(chip("poet10"), "pointerup", "mouse");
        chip("poet10").click();
      });
      expect(openRun).toHaveBeenCalledExactlyOnceWith({ jobId: "parent-job-poet10-job", title: "@poet10 run" });

      await longPressWithoutClick();
      await act(async () => {
        chip("poet10").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        chip("poet10").click();
      });
      expect(openRun).toHaveBeenCalledTimes(2);

      // A screen reader's activation is a click with no press before it.
      await longPressWithoutClick();
      await act(async () => { chip("poet10").click(); });
      expect(openRun).toHaveBeenCalledTimes(3);

      await longPressWithoutClick();
      await act(async () => { pointer(chip("poet10"), "pointerdown", "mouse", { button: 2 }); });
      // The message's own menu, as a right-click anywhere else in it opens.
      expect(contextMenu(chip("poet10"))).toBe(true);
      expect(bubbleContextMenu).toHaveBeenCalledTimes(1);
    });

    it("ends with a short tap, or when the browser takes the touch to scroll, and never opens the menu later", async () => {
      await renderInBubble();
      await act(async () => {
        pointer(chip("poet09"), "pointerdown", "touch");
        pointer(chip("poet09"), "pointerup", "touch");
        chip("poet09").click();
      });
      expect(openRun).toHaveBeenCalledExactlyOnceWith({ jobId: "parent-job-poet09-job", title: "@poet09 run" });
      await wait(1000);
      expect(menu()).toBeNull();

      await act(async () => { pointer(chip("poet10"), "pointerdown", "touch"); });
      await wait(100);
      await act(async () => { pointer(chip("poet10"), "pointercancel", "touch"); });
      await wait(1000);
      expect(menu()).toBeNull();
    });

    it("is ended only by the pointer that started it, and a pen's long-press opens the menu too", async () => {
      await renderInBubble();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "touch", {}, 7); });
      // A second finger lifting is not the first one letting go.
      await act(async () => { pointer(chip("poet09"), "pointerup", "touch", {}, 8); });
      await wait(420);
      expect(menu()?.getAttribute("aria-label")).toBe("Actions for @poet09");
      await escape();
      expect(menu()).toBeNull();

      await act(async () => { pointer(chip("poet10"), "pointerdown", "pen"); });
      expect(bubblePointerDown).not.toHaveBeenCalled();
      await wait(420);
      expect(menu()?.getAttribute("aria-label")).toBe("Actions for @poet10");
    });

    it("opens the menu at once on Android's long-press contextmenu when that comes before 420ms", async () => {
      await renderInBubble();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "touch"); });
      await wait(300);
      let notPrevented = true;
      await act(async () => { notPrevented = contextMenu(chip("poet09")); });
      expect(notPrevented).toBe(false);
      expect(bubbleContextMenu).not.toHaveBeenCalled();
      expect(menu()?.getAttribute("aria-label")).toBe("Actions for @poet09");
      await act(async () => {
        pointer(chip("poet09"), "pointerup", "touch");
        chip("poet09").click();
      });
      expect(openRun).not.toHaveBeenCalled();
    });

    it("keeps a contextmenu on the open menu from opening the message's menu", async () => {
      // A right-click on it, or Android's long-press contextmenu where the
      // platform's long-press outlasts 420ms (its longer touch-and-hold
      // settings) and the finger is over the menu. The menu is portaled out
      // of the bubble, but React bubbles its events through the lane.
      await renderInBubble();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "touch"); });
      await wait(420);
      const item = menu()!.querySelector('[role="menuitem"]')!;
      expect(container.contains(item)).toBe(false);
      expect(contextMenu(item)).toBe(false);
      expect(contextMenu(menu()!)).toBe(false);
      expect(bubbleContextMenu).not.toHaveBeenCalled();
      expect(menu()).not.toBeNull();
      await escape();
      // The same for a menu opened from its "…" with a mouse.
      await act(async () => {
        chip("poet10").parentElement!.querySelector<HTMLButtonElement>('[data-testid="multi-agent-chip-menu-button"]')!.click();
      });
      expect(menu()?.getAttribute("aria-label")).toBe("Actions for @poet10");
      expect(contextMenu(menu()!.querySelector('[role="menuitem"]')!)).toBe(false);
      expect(bubbleContextMenu).not.toHaveBeenCalled();
      // Once it is closed, a right-click on the chip opens the message's menu.
      await escape();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "mouse", { button: 2 }); });
      expect(contextMenu(chip("poet09"))).toBe(true);
      expect(bubbleContextMenu).toHaveBeenCalledTimes(1);
    });

    it("takes focus from a field, so the field does not get it back when the long-press menu closes", async () => {
      // On a phone the composer would get focus back, and its keyboard with it.
      await renderInBubble();
      const composer = document.createElement("textarea");
      document.body.append(composer);
      try {
        composer.focus();
        await act(async () => { pointer(chip("poet09"), "pointerdown", "touch"); });
        await wait(420);
        await act(async () => { pointer(chip("poet09"), "pointerup", "touch"); });
        await frames();
        expect(menu()?.contains(document.activeElement)).toBe(true);
        await escape();
        await frames();
        expect(menu()).toBeNull();
        expect(document.activeElement).toBe(document.body);
      } finally {
        composer.remove();
      }
    });

    it("opens nothing for a lane that leaves the plan mid-press, then or when it comes back", async () => {
      await renderInBubble();
      await act(async () => { pointer(chip("poet09"), "pointerdown", "touch"); });
      await wait(100);
      await renderInBubble([{ handle: "poet10" }]);
      expect(container.querySelector('[data-agent-handle="@poet09"]')).toBeNull();
      await wait(400);
      expect(menu()).toBeNull();
      await renderInBubble();
      expect(menu()).toBeNull();
      expect(chip("poet09").parentElement?.querySelector('[data-testid="multi-agent-chip-menu-button"]')
        ?.getAttribute("aria-expanded")).not.toBe("true");
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
