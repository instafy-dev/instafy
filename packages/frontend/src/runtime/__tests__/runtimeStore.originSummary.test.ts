import { describe, expect, it } from "vitest";
import { createInitialRuntimeStoreState, runtimeReducer } from "../runtimeStore";

const summary = { originId: "desk-origin", mode: "desktop", endpoint: "http://desk" };

describe("runtime store origin summary", () => {
  it("remembers which project the summary belongs to and forgets it with the summary", () => {
    const withOrigin = runtimeReducer(createInitialRuntimeStoreState(), {
      type: "applyOriginSummary",
      summary,
      derivedPresence: null,
      projectId: "desk-project",
    });
    expect(withOrigin.desktopOrigin).toEqual(summary);
    expect(withOrigin.desktopOriginProjectId).toBe("desk-project");

    const cleared = runtimeReducer(withOrigin, { type: "applyOriginSummary", summary: null, derivedPresence: null });
    expect(cleared.desktopOrigin).toBeNull();
    expect(cleared.desktopOriginProjectId).toBeNull();

    const unknown = runtimeReducer(cleared, { type: "applyOriginSummary", summary, derivedPresence: null });
    expect(unknown.desktopOriginProjectId).toBeNull();
  });
});
