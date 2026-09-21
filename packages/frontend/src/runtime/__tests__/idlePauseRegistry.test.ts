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
