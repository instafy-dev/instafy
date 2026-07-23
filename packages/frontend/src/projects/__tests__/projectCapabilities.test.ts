import { describe, expect, it } from "vitest";
import {
  canOpenProjectDeviceHandoff,
  resolveProjectCapabilities,
} from "../projectCapabilities";

const baseSummary = {
  projectId: "project-1",
  orgId: "org-1",
};

describe("resolveProjectCapabilities", () => {
  it("keeps viewers read-only when the controller returns explicit capabilities", () => {
    expect(
      resolveProjectCapabilities(
        {
          ...baseSummary,
          effectiveRole: "viewer",
          canWrite: false,
          canShare: false,
          canManage: false,
        },
        "viewer-1",
      ),
    ).toEqual({
      effectiveRole: "viewer",
      canWrite: false,
      canShare: false,
      canManage: false,
    });
  });

  it("preserves a builder's write access without inventing share rights", () => {
    expect(
      resolveProjectCapabilities(
        {
          ...baseSummary,
          effectiveRole: "builder",
          canWrite: true,
          canShare: false,
          canManage: false,
        },
        "builder-1",
      ),
    ).toEqual({
      effectiveRole: "builder",
      canWrite: true,
      canShare: false,
      canManage: false,
    });
  });

  it("recognizes the owner on an older controller response", () => {
    expect(
      resolveProjectCapabilities(
        { ...baseSummary, ownerUserId: "owner-1" },
        "owner-1",
      ),
    ).toEqual({
      effectiveRole: "owner",
      canWrite: true,
      canShare: true,
      canManage: true,
    });
  });

  it("does not guess access from an old response for a non-owner", () => {
    expect(resolveProjectCapabilities(baseSummary, "member-1")).toBeNull();
  });
});

describe("canOpenProjectDeviceHandoff", () => {
  it("keeps same-account handoff available after access resolves regardless of share rights", () => {
    expect(canOpenProjectDeviceHandoff("project-1", true)).toBe(true);
  });

  it("waits for access resolution and an active project", () => {
    expect(canOpenProjectDeviceHandoff("project-1", false)).toBe(false);
    expect(canOpenProjectDeviceHandoff(null, true)).toBe(false);
  });
});
