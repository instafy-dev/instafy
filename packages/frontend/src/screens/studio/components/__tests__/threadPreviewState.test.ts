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

  it("suppresses duplicate summary running labels when compact rail already owns the live status", () => {
    expect(
      shouldSuppressSummaryRunningStatus({
        showCompactRailStatus: true,
        showRunningSpinnerFallback: true,
        useCompactRunningPreview: false,
        hasRunningStatusLabel: false,
      }),
    ).toBe(true);

    expect(
      shouldSuppressSummaryRunningStatus({
        showCompactRailStatus: true,
        showRunningSpinnerFallback: false,
        useCompactRunningPreview: true,
        hasRunningStatusLabel: true,
      }),
    ).toBe(true);

    expect(
      shouldSuppressSummaryRunningStatus({
        showCompactRailStatus: false,
        showRunningSpinnerFallback: true,
        useCompactRunningPreview: true,
        hasRunningStatusLabel: true,
      }),
    ).toBe(false);
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
});
