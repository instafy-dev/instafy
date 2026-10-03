import { describe, expect, it } from "vitest";
import {
  canOpenProjectDeviceHandoff,
  resolveChatAttachmentsMode,
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
      chatAttachments: null,
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
      chatAttachments: null,
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
      chatAttachments: null,
    });
  });

  it("reads whether chat attachments can be stored, and nothing else", () => {
    const resolve = (attachments: unknown) =>
      resolveProjectCapabilities(
        { ...baseSummary, effectiveRole: "builder", attachments: attachments as string },
        "builder-1",
      )?.chatAttachments;
    expect(resolve("storage")).toBe("storage");
    expect(resolve("none")).toBe("none");
    expect(resolve(" NONE ")).toBe("none");
    // An older controller says nothing, and an unknown answer is not "none".
    expect(resolve(undefined)).toBeNull();
    expect(resolve("s3")).toBeNull();
  });

  it("turns attachments off without a Supabase configuration, whatever the server says", () => {
    expect(resolveChatAttachmentsMode(false, { chatAttachments: "storage" })).toBe("none");
    expect(resolveChatAttachmentsMode(false, null)).toBe("none");
    expect(resolveChatAttachmentsMode(true, { chatAttachments: "storage" })).toBe("storage");
    expect(resolveChatAttachmentsMode(true, { chatAttachments: "none" })).toBe("none");
    // Unknown (an older controller, or a space still loading) stays on.
    expect(resolveChatAttachmentsMode(true, { chatAttachments: null })).toBeNull();
    expect(resolveChatAttachmentsMode(true, null)).toBeNull();
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
