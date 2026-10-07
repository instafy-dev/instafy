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

describe("runtime store origin events and hydration", () => {
  const resolved = {
    originId: "desk-origin",
    runtimeId: "runtime-desk",
    endpoint: "https://ctl/origin/desk-origin",
    mode: "desktop",
    presence: { status: "online" as const, lastHeartbeat: "2026-10-07T10:00:00Z" },
  };
  const workspace = {
    deviceId: "device-1",
    path: "/Users/me/space",
    runtimeId: "runtime-desk",
    status: "online" as const,
    lastHeartbeat: "2026-10-07T10:00:00Z",
  };
  const hydrated = runtimeReducer(createInitialRuntimeStoreState(), {
    type: "applyOriginHydration",
    workspace,
    summary: resolved,
    derivedPresence: null,
    projectId: "desk-project",
  });

  it("applies the workspace and the origin of one hydration pass together", () => {
    expect(hydrated.localWorkspace).toEqual(workspace);
    expect(hydrated.desktopOrigin).toEqual(resolved);
    expect(hydrated.desktopOriginProjectId).toBe("desk-project");

    // The controller answered that the space has neither any more.
    const gone = runtimeReducer(hydrated, {
      type: "applyOriginHydration",
      workspace: null,
      summary: null,
      derivedPresence: null,
      projectId: "desk-project",
    });
    expect(gone.localWorkspace).toBeNull();
    expect(gone.desktopOrigin).toBeNull();
    expect(gone.desktopOriginProjectId).toBeNull();
  });

  it("takes only presence from an event for the default origin", () => {
    const next = runtimeReducer(hydrated, {
      type: "applyOriginEvent",
      summary: {
        originId: "desk-origin",
        runtimeId: null,
        endpoint: "https://elsewhere/origin/desk-origin",
        mode: "hosted",
        presence: { status: "offline", lastHeartbeat: "2026-10-07T10:00:20Z" },
      },
      derivedPresence: {
        deviceId: "desk-origin",
        status: "offline",
        presenceStatus: "offline",
        lastHeartbeat: "2026-10-07T10:00:20Z",
      },
    });
    expect(next.desktopOrigin).toEqual({
      ...resolved,
      presence: { status: "offline", lastHeartbeat: "2026-10-07T10:00:20Z" },
    });
    expect(next.desktopOriginProjectId).toBe("desk-project");
    expect(next.localWorkspace).toMatchObject({
      deviceId: "device-1",
      path: "/Users/me/space",
      runtimeId: "runtime-desk",
      status: "offline",
      lastHeartbeat: "2026-10-07T10:00:20Z",
    });
  });

  it("ignores an event from any other origin of the project", () => {
    const next = runtimeReducer(hydrated, {
      type: "applyOriginEvent",
      summary: {
        originId: "runtime-origin",
        endpoint: "https://ctl/origin/runtime-origin",
        mode: "hosted",
        presence: { status: "online" },
      },
      derivedPresence: { deviceId: "runtime-origin", status: "online" },
    });
    expect(next).toBe(hydrated);
    expect(
      runtimeReducer(createInitialRuntimeStoreState(), {
        type: "applyOriginEvent",
        summary: resolved,
        derivedPresence: null,
      }).desktopOrigin,
    ).toBeNull();
  });
});
