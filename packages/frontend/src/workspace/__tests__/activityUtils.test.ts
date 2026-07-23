import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../types";
import { hasActiveRunsForProject } from "../useWorkspaceActivity";

function createRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run",
    projectId: "project",
    sessionId: null,
    conversationId: null,
    promptId: null,
    runType: "prompt",
    status: "queued",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: null,
    createdAt: null,
    updatedAt: null,
    ...overrides
  };
}

describe("hasActiveRunsForProject", () => {
  it("returns false when project id is missing", () => {
    expect(hasActiveRunsForProject(null, {}, {})).toBe(false);
  });

  it("returns true when there are leased runs", () => {
    expect(
      hasActiveRunsForProject("project", {}, { "run-1": true })
    ).toBe(true);
  });

  it("returns true when a run is queued for the active project", () => {
    const runs: Record<string, RunRecord> = {
      "run-1": createRun({ id: "run-1", status: "queued" })
    };
    expect(hasActiveRunsForProject("project", runs, {})).toBe(true);
  });

  it("ignores stale queued runs for the active project", () => {
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const runs: Record<string, RunRecord> = {
      "run-1": createRun({ id: "run-1", status: "queued", updatedAt: staleTimestamp })
    };
    expect(hasActiveRunsForProject("project", runs, {})).toBe(false);
  });

  it("ignores runs that belong to other projects", () => {
    const runs: Record<string, RunRecord> = {
      "run-1": createRun({ id: "run-1", projectId: "other", status: "in_progress" })
    };
    expect(hasActiveRunsForProject("project", runs, {})).toBe(false);
  });

  it("returns false when all runs are completed", () => {
    const runs: Record<string, RunRecord> = {
      "run-1": createRun({ id: "run-1", status: "success" }),
      "run-2": createRun({ id: "run-2", status: "failed" })
    };
    expect(hasActiveRunsForProject("project", runs, {})).toBe(false);
  });
});
