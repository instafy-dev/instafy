// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_PAUSE_CLEARED_EVENT,
  MANUAL_STOP_CHANGED_EVENT,
  clearIdlePaused,
  clearManualStop,
  isAutoEnsureHeld,
  isIdlePaused,
  isManualStopHeld,
  markIdlePaused,
  markManualStop,
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

  it("survives the pointer wake that clears an idle pause", () => {
    markIdlePaused("project-a");
    markManualStop("project-a");

    // StudioLayout calls this on any pointerdown/keydown.
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
