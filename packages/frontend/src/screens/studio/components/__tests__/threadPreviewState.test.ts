import { describe, expect, it } from "vitest";
import {
  isThreadPreviewUnresolved,
  resolveCompactRailStatusText,
  shouldRenderCompactRailStatus,
  shouldSuppressSummaryRunningStatus,
  shouldSweepCompactRailStatusText,
} from "../threadPreviewState";
import { resolveThreadRunStatusFromMessages } from "../threadPreviewHelpers";

describe("threadPreviewState", () => {
  it("treats pending or recent thread activity as unresolved even before running is confirmed", () => {
    expect(
      isThreadPreviewUnresolved({
        isCompleted: false,
        isRunning: false,
        isThreadRunInFlight: true,
        hasRecentThreadActivity: false,
        runPhase: "unknown",
      }),
    ).toBe(true);

    expect(
      isThreadPreviewUnresolved({
        isCompleted: false,
        isRunning: false,
        isThreadRunInFlight: false,
        hasRecentThreadActivity: true,
        runPhase: "unknown",
      }),
    ).toBe(true);
  });

  it("does not treat stale saved-running state as unresolved by itself", () => {
    expect(
      isThreadPreviewUnresolved({
        isCompleted: false,
        isRunning: false,
        isThreadRunInFlight: false,
        hasRecentThreadActivity: false,
        runPhase: "running",
      }),
    ).toBe(false);
  });

  it("falls back to the newest compacted event label before generic thinking text", () => {
    expect(
      resolveCompactRailStatusText({
        showCompactRailCommandStatus: false,
        commandPreview: "",
        latestCompactEventKind: "search",
        runningStatusLabel: null,
      }),
    ).toBe("Searching the web…");
  });

  it("renders compact rail status for unresolved hybrid rails and sweeps only while unresolved", () => {
    const showCompactRailStatus = shouldRenderCompactRailStatus({
      isHybridCompactionActive: true,
      isCompleted: false,
      showLiveCommandOutput: false,
      isUnresolved: true,
      showCompactIconRail: true,
      showCompactRailWaitingSpinner: false,
    });

    expect(showCompactRailStatus).toBe(true);
    expect(
      shouldSweepCompactRailStatusText({
        showCompactRailStatus,
        isUnresolved: true,
      }),
    ).toBe(true);
    expect(
      shouldSweepCompactRailStatusText({
        showCompactRailStatus,
        isUnresolved: false,
      }),
    ).toBe(false);
  });

  it("lets the compact rail caption be the only running status under the rail", () => {
    // Any running summary under the caption, a short label or a multi-line
    // preview box alike, would come and go with each command and move the rail.
    expect(shouldSuppressSummaryRunningStatus({ showCompactRailStatus: true })).toBe(true);
    expect(shouldSuppressSummaryRunningStatus({ showCompactRailStatus: false })).toBe(false);
  });

  it("treats non-recoverable quota errors as terminal thread state", () => {
    expect(
      resolveThreadRunStatusFromMessages([
        {
          id: "msg-1",
          role: "assistant",
          content: "Thinking…",
          timestamp: 1,
          messageType: "status",
          metadata: {
            messageType: "status",
            outcome: "in_progress",
          },
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Upstream 429 rejected the AI request (insufficient_quota).",
          timestamp: 2,
          messageType: "error",
          metadata: {
            messageType: "error",
            outcome: "in_progress",
            runId: "run-1",
          },
        },
      ]),
    ).toEqual({ phase: "completed", status: "failed" });

    expect(
      resolveThreadRunStatusFromMessages([
        {
          id: "msg-1",
          role: "assistant",
          content: "Thinking…",
          timestamp: 1,
          messageType: "status",
          metadata: {
            messageType: "status",
            outcome: "in_progress",
          },
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Upstream 429 rejected the AI request (insufficient_quota).",
          timestamp: 2,
          messageType: "status",
          metadata: {
            messageType: "status",
            outcome: "in_progress",
            runId: "run-1",
          },
        },
      ]),
    ).toEqual({ phase: "completed", status: "failed" });
  });

  it("treats a controller-written run failure as terminal thread state", () => {
    // The controller fails a turn a stop put back in the queue once no machine
    // picks it up in time. Its message is the thread's only entry.
    const content =
      "This run was interrupted when its runtime stopped and was not resumed within 15 minutes. Send it again if you still need it.";
    expect(
      resolveThreadRunStatusFromMessages([
        {
          id: "msg-1",
          role: "assistant",
          content,
          timestamp: 1,
          messageType: "error",
          metadata: {
            source: "controller",
            kind: "interrupted_run_expired",
            outcome: "failed",
            messageType: "error",
            jobId: "job-1",
            runId: "run-1",
            errorMessage: content,
            interruptionReason: "user_stop",
            agent: { handle: "octo" },
          },
        },
      ]),
    ).toEqual({ phase: "completed", status: "failed" });
  });

  describe("a job's reply", () => {
    const progress = (id: string, jobId: string, timestamp: number, details: Record<string, unknown> = {}) => ({
      id,
      role: "assistant" as const,
      content: "Counting the entries",
      timestamp,
      messageType: "status",
      metadata: { source: "agent", kind: "update", outcome: "in_progress", messageType: "status", jobId, details },
    });
    const reply = (id: string, jobId: string, timestamp: number) => ({
      id,
      role: "assistant" as const,
      content: "There are 12 files in this space.",
      timestamp,
      metadata: { source: "agent", outcome: "succeeded", jobId },
    });

    it("settles the turn over progress of its job stamped after it", () => {
      // A message's time is when the transaction that wrote it began, so the
      // job's last progress can read as newer than the reply that ended it.
      expect(
        resolveThreadRunStatusFromMessages([
          progress("status-1", "job-1", 1),
          reply("reply-1", "job-1", 2),
          progress("status-2", "job-1", 3),
        ]),
      ).toEqual({ phase: "completed", status: "succeeded" });
    });

    it("leaves a newer job's progress running", () => {
      expect(
        resolveThreadRunStatusFromMessages([reply("reply-1", "job-1", 2), progress("status-2", "job-2", 3)]),
      ).toEqual({ phase: "running", status: "in_progress" });
    });

    it("is never a streamed copy of the answer", () => {
      // The answer is streamed as a progress update before the job completes.
      expect(
        resolveThreadRunStatusFromMessages([progress("status-1", "job-1", 2, { kind: "agent_message" })]),
      ).toEqual({ phase: "running", status: "in_progress" });
    });

    it("is never a terminal row made up from a run record", () => {
      // Its job id is only a guess, so it must not end a job that is still running.
      expect(
        resolveThreadRunStatusFromMessages([
          { ...reply("thread-preview-terminal:run-2", "job-1", 2), content: "Completed." },
          progress("status-2", "job-1", 3),
        ]),
      ).toEqual({ phase: "running", status: "in_progress" });
    });

    it("is not a controller-written outcome, which a resumed job can follow", () => {
      expect(
        resolveThreadRunStatusFromMessages([
          {
            id: "notice-1",
            role: "assistant",
            content: "The run stopped.",
            timestamp: 2,
            messageType: "error",
            metadata: { source: "controller", outcome: "failed", messageType: "error", jobId: "job-1" },
          },
          progress("status-2", "job-1", 3),
        ]),
      ).toEqual({ phase: "running", status: "in_progress" });
    });
  });
});
