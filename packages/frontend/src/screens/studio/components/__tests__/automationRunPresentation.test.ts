import { describe, expect, it } from "vitest";
import type { ControllerAutomation } from "../../../../sdk/instafy";
import type { RunRecord, RunStatus } from "../../../../types";
import { getAutomationLatestRun, getAutomationRunPresentation, getAutomationScheduleLabel } from "../automationRunPresentation";

const automation: ControllerAutomation = {
  id: "automation-a", projectId: "project-a", userId: "user-a", name: "Check reports",
  promptText: "Check reports", metadata: {}, scheduleKind: "once", runAt: "2026-09-08T10:00:00Z",
  intervalHours: null, byDay: [], byHour: null, byMinute: null, timezone: "UTC",
  runtimeMode: "auto", runtimeProvider: null, conversationId: "thread-a",
  silentWhenNothingToReport: false, status: "paused", lockedUntil: null,
  lastRunAt: "2026-09-08T10:00:00Z", nextRunAt: null, lastError: null,
  createdAt: "2026-09-08T09:00:00Z", updatedAt: "2026-09-08T10:00:00Z",
};

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-a", projectId: automation.projectId, sessionId: null, conversationId: automation.conversationId,
    promptId: null, runType: "prompt", status: "success", progress: 100, progressStage: null, previewUrl: null,
    lastMessage: "The turn ended, but repository access is still required.", metadata: { automation: { id: automation.id } },
    createdAt: "2026-09-08T10:00:01Z", updatedAt: "2026-09-08T10:01:00Z", ...overrides,
  };
}

describe("automation schedule and turn presentation", () => {
  it("calls a one-time schedule finished even when its launch failed, without implying success", () => {
    expect(getAutomationScheduleLabel({ ...automation, lastError: "Runtime unavailable" })).toBe("One-time schedule finished");
    expect(getAutomationScheduleLabel({ ...automation, lastRunAt: null })).toBe("Schedule paused");
    expect(getAutomationScheduleLabel({ ...automation, scheduleKind: "weekly", status: "active" })).toBe("Schedule active");
  });

  it.each<[RunStatus, string]>([
    ["queued", "Turn queued"], ["in_progress", "Turn running"], ["awaiting_approval", "Awaiting approval"],
    ["success", "Turn completed"], ["failed", "Turn failed"], ["canceled", "Turn canceled"], ["merged", "Turn merged"],
  ])("uses the typed %s state", (status, label) => {
    expect(getAutomationRunPresentation(run({ status })).label).toBe(label);
  });

  it("preserves a blocked-looking summary without guessing its outcome from prose", () => {
    const result = getAutomationRunPresentation(run());
    expect(result.label).toBe("Turn completed");
    expect(result.summary).toBe("The turn ended, but repository access is still required.");
    expect(result.tone).toBe("muted");
    expect(getAutomationRunPresentation(run({ status: "failed", lastMessage: "Everything succeeded" })).label).toBe("Turn failed");
  });

  it("bounds excerpts without splitting Unicode characters", () => {
    expect(getAutomationRunPresentation(run({ lastMessage: "🙂".repeat(401) })).summary).toBe(`${"🙂".repeat(400)}…`);
  });

  it("requires exact project, automation and thread attribution", () => {
    expect(getAutomationLatestRun(automation, [
      run({ projectId: "other-project" }), run({ conversationId: "other-thread" }),
      run({ metadata: null }), run({ metadata: { automation: { id: "other-automation" } } }),
      run({ runType: "build" }),
    ])).toBeNull();
    expect(getAutomationLatestRun(automation, [run()])?.id).toBe("run-a");
  });

  it("never shows an older successful turn as the latest launch result", () => {
    expect(getAutomationLatestRun(automation, [run({ createdAt: "2026-09-08T09:00:00Z", updatedAt: "2026-09-08T11:00:00Z" })])).toBeNull();
    expect(getAutomationLatestRun(automation, [run({ createdAt: null })])).toBeNull();
    expect(getAutomationLatestRun({ ...automation, lastRunAt: "invalid" }, [run()])).toBeNull();
  });

  it("chooses the newest attempt by creation time, not completion time or array order", () => {
    const first = run({ id: "earlier", updatedAt: "2026-09-08T11:00:00Z" });
    const latest = run({ id: "latest", createdAt: "2026-09-08T10:05:00Z", status: "in_progress" });
    expect(getAutomationLatestRun(automation, [latest, first])).toBe(latest);
  });
});
