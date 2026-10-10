// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_PAUSE_CLEARED_EVENT,
  MANUAL_STOP_CHANGED_EVENT,
  clearIdlePaused,
  clearManualStop,
  forgetSupersededPersonStopsForTests,
  idlePausedAt,
  isAutoEnsureHeld,
  isIdlePaused,
  isManualStopHeld,
  manualStopHold,
  markIdlePaused,
  markManualStop,
  personStopsSupersededAtMs,
  recordManualStopFlush,
  supersedePersonStops,
} from "../idlePauseRegistry";

describe("idlePauseRegistry manual stop hold", () => {
  afterEach(() => {
    for (const projectId of ["project-a", "project-b"]) {
      clearManualStop(projectId);
      clearIdlePaused(projectId);
    }
  });

  it("holds per project until explicitly cleared", () => {
    expect(isManualStopHeld("project-a")).toBe(false);

    markManualStop("project-a");

    expect(isManualStopHeld("project-a")).toBe(true);
    expect(isManualStopHeld("project-b")).toBe(false);
    expect(isAutoEnsureHeld("project-a")).toBe(true);

    clearManualStop("project-a");

    expect(isManualStopHeld("project-a")).toBe(false);
    expect(isAutoEnsureHeld("project-a")).toBe(false);
  });

  it("ignores empty ids", () => {
    markManualStop("");
    markManualStop(null);
    markManualStop(undefined);
    expect(isManualStopHeld("")).toBe(false);
    expect(isManualStopHeld(null)).toBe(false);
  });

  it("survives the composer wake that clears an idle pause", () => {
    markIdlePaused("project-a");
    markManualStop("project-a");

    // useComposerIntentWake calls this when someone types in the chat.
    clearIdlePaused("project-a");

    expect(isIdlePaused("project-a")).toBe(false);
    expect(isManualStopHeld("project-a")).toBe(true);
    expect(isAutoEnsureHeld("project-a")).toBe(true);
  });

  it("dispatches one change event per transition and none for no-ops", () => {
    const changed = vi.fn();
    const idleCleared = vi.fn();
    window.addEventListener(MANUAL_STOP_CHANGED_EVENT, changed);
    window.addEventListener(IDLE_PAUSE_CLEARED_EVENT, idleCleared);
    try {
      clearManualStop("project-a");
      expect(changed).not.toHaveBeenCalled();

      markManualStop("project-a");
      markManualStop("project-a");
      expect(changed).toHaveBeenCalledTimes(1);
      expect((changed.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        projectId: "project-a",
      });

      clearManualStop("project-a");
      clearManualStop("project-a");
      expect(changed).toHaveBeenCalledTimes(2);
      expect(idleCleared).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(MANUAL_STOP_CHANGED_EVENT, changed);
      window.removeEventListener(IDLE_PAUSE_CLEARED_EVENT, idleCleared);
    }
  });

  it("records when the latest Stop was made, and its flush once that stop answers", () => {
    const changed = vi.fn();
    window.addEventListener(MANUAL_STOP_CHANGED_EVENT, changed);
    const now = vi.spyOn(Date, "now");
    try {
      expect(manualStopHold("project-a")).toBeNull();
      now.mockReturnValue(1_000);
      const first = markManualStop("project-a");
      expect(manualStopHold("project-a")).toEqual({ at: 1_000, flush: null });
      expect(first).toBe(manualStopHold("project-a"));

      // A later Stop that again leaves no machine is the one that cut off
      // what runs now; the first stop's answer no longer describes the hold.
      now.mockReturnValue(5_000);
      const second = markManualStop("project-a");
      expect(manualStopHold("project-a")).toEqual({ at: 5_000, flush: null });
      recordManualStopFlush("project-a", first, { status: "failed", unpushedRefs: null, error: "origin_timeout" });
      expect(manualStopHold("project-a")?.flush).toBeNull();
      expect(changed).toHaveBeenCalledTimes(1);

      const saved = { status: "flushed", unpushedRefs: 0, error: null };
      recordManualStopFlush("project-a", second, saved);
      expect(manualStopHold("project-a")).toEqual({ at: 5_000, flush: saved });
      expect(changed).toHaveBeenCalledTimes(2);
      expect(isManualStopHeld("project-a")).toBe(true);

      // Lifted on Start, a send or a failed stop: an answer arriving later sets nothing.
      clearManualStop("project-a");
      recordManualStopFlush("project-a", second, saved);
      expect(manualStopHold("project-a")).toBeNull();
      expect(isManualStopHeld("project-a")).toBe(false);
      expect(changed).toHaveBeenCalledTimes(3);
      expect(markManualStop(null)).toBeNull();
    } finally {
      now.mockRestore();
      window.removeEventListener(MANUAL_STOP_CHANGED_EVENT, changed);
    }
  });
});

describe("idlePauseRegistry restored-space hold", () => {
  afterEach(async () => {
    const { clearRestoredAwaitingIntent } = await import("../idlePauseRegistry");
    clearRestoredAwaitingIntent("project-a");
    clearIdlePaused("project-a");
  });

  it("holds a space startup reopened until intent lifts it, and signals the lift", async () => {
    const { clearRestoredAwaitingIntent, isRestoredAwaitingIntent, markRestoredAwaitingIntent } =
      await import("../idlePauseRegistry");
    const lifted = vi.fn();
    window.addEventListener(IDLE_PAUSE_CLEARED_EVENT, lifted);

    markRestoredAwaitingIntent("project-a");
    expect(isRestoredAwaitingIntent("project-a")).toBe(true);
    expect(isAutoEnsureHeld("project-a")).toBe(true);
    expect(isRestoredAwaitingIntent("project-b")).toBe(false);

    // A pointer wake clears idle pauses only; choosing another space from the
    // navigation must not start the machine being left.
    clearIdlePaused("project-a");
    expect(isRestoredAwaitingIntent("project-a")).toBe(true);

    clearRestoredAwaitingIntent("project-a");
    expect(isRestoredAwaitingIntent("project-a")).toBe(false);
    expect(isAutoEnsureHeld("project-a")).toBe(false);
    expect(lifted).toHaveBeenCalledTimes(1);

    clearRestoredAwaitingIntent("project-a");
    expect(lifted).toHaveBeenCalledTimes(1);
    window.removeEventListener(IDLE_PAUSE_CLEARED_EVENT, lifted);
  });
});

describe("idlePauseRegistry idle pause time", () => {
  afterEach(() => {
    clearIdlePaused("project-a");
  });

  it("records when the latest pause was set", () => {
    const now = vi.spyOn(Date, "now");
    try {
      expect(idlePausedAt("project-a")).toBeNull();
      now.mockReturnValue(1_000);
      markIdlePaused("project-a");
      expect(idlePausedAt("project-a")).toBe(1_000);
      now.mockReturnValue(5_000);
      markIdlePaused("project-a");
      expect(idlePausedAt("project-a")).toBe(5_000);
      expect(idlePausedAt("project-b")).toBeNull();
      expect(idlePausedAt(null)).toBeNull();

      clearIdlePaused("project-a");
      expect(idlePausedAt("project-a")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

describe("idlePauseRegistry superseded person's stops", () => {
  afterEach(() => {
    forgetSupersededPersonStopsForTests();
  });

  it("keeps the latest person's stop a request overrode, per project", () => {
    expect(personStopsSupersededAtMs("project-a")).toBeNull();

    supersedePersonStops("project-a", 5_000);
    // A request that knew of no stop, or only an earlier one, changes nothing.
    supersedePersonStops("project-a", null);
    supersedePersonStops("project-a", 1_000);
    expect(personStopsSupersededAtMs("project-a")).toBe(5_000);
    supersedePersonStops("project-a", 9_000);
    expect(personStopsSupersededAtMs("project-a")).toBe(9_000);

    expect(personStopsSupersededAtMs("project-b")).toBeNull();
    supersedePersonStops(null, 1_000);
    expect(personStopsSupersededAtMs(null)).toBeNull();
  });
});
