import { describe, expect, it } from "vitest";
import { resolveStudioUrlProjectId } from "../studioProjectUrlSync";

describe("resolveStudioUrlProjectId", () => {
  it("prefers the incoming URL project when it differs from stale active state", () => {
    expect(
      resolveStudioUrlProjectId({
        activeProjectId: "850a0f5b-ca83-40b9-8ada-8f54caaacf79",
        urlProjectId: "b0f7c165-18d1-420d-90da-be8c29018e0d",
      }),
    ).toBe("b0f7c165-18d1-420d-90da-be8c29018e0d");
  });

  it("keeps the active project when an internal switch is already pending", () => {
    expect(
      resolveStudioUrlProjectId({
        activeProjectId: "850a0f5b-ca83-40b9-8ada-8f54caaacf79",
        urlProjectId: "b0f7c165-18d1-420d-90da-be8c29018e0d",
        pendingProjectSwitch: {
          projectId: "850a0f5b-ca83-40b9-8ada-8f54caaacf79",
          at: 9_000,
        },
        now: 10_000,
      }),
    ).toBe("850a0f5b-ca83-40b9-8ada-8f54caaacf79");
  });

  it("ignores stale pending project switches", () => {
    expect(
      resolveStudioUrlProjectId({
        activeProjectId: "850a0f5b-ca83-40b9-8ada-8f54caaacf79",
        urlProjectId: "b0f7c165-18d1-420d-90da-be8c29018e0d",
        pendingProjectSwitch: {
          projectId: "850a0f5b-ca83-40b9-8ada-8f54caaacf79",
          at: 1_000,
        },
        now: 10_000,
      }),
    ).toBe("b0f7c165-18d1-420d-90da-be8c29018e0d");
  });
});
